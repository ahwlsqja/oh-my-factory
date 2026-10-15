import { type CanaryIndexEntry, attributeCanaryHits } from "../audit/attribute.js";
import { type AuditSurface, type SurfaceKind, textSurface } from "../audit/canary-scan.js";
import { type WorkAudit, auditInputsOf, auditSignals, recordAudit, runAudit } from "../audit/work-audit.js";
import { WorkCopyError } from "../container/work-copy.js";
import { canonicalize, sha256Hex } from "../core/canonical-json.js";
import { registerCleanup } from "../core/cleanup-registry.js";
import { EXTRA_HIGH_RISK_GLOBS } from "../core/config.js";
import { Ledger } from "../core/ledger.js";
import type { LedgerEvent } from "../core/ledger.js";
import type { ProjectLocation } from "../core/paths.js";
import { findDecision, foldDecisions } from "../decision/state.js";
import {
  type DecisionScope,
  INTERFACE_DECISION_ID,
  type InterfaceContract,
  type JudgeConfigDecl,
  judgeConfigDecl,
} from "../decision/types.js";
import { auditPayloadOf, gatesEvaluatedEvent } from "../gate/events.js";
import type { RunOptions, WorkCopyFactory } from "../gate/ports.js";
import { type ProveTestResult, proveTest } from "../gate/prove-test.js";
import { type GateRunResult, runGates } from "../gate/run-gates.js";
import { auditGoal } from "../goal/audit.js";
import { type GitTarget, HostGitError } from "../git/hardened.js";
import { commitMessages, unifiedDiff } from "../git/ops.js";
import { loadRunIsolation } from "../isolation/record.js";
import { ScenarioStatusError, foldSeals, markScenarioStatus } from "../scenario/events.js";
import { locationEnv } from "../vault/line-guard.js";
import { listVaultCanaryIndex, openVault } from "../vault/vault.js";
import type { Station, StationContext, StationResult } from "../work/sequencer.js";
import type { ReasonCode } from "../work/w-events.js";
import type { CandidateRef, CandidateSource } from "./candidate.js";
import type { FeedbackSlot } from "./state.js";
import { WorkCopiesError } from "./work-copies.js";

/** What S5 needs of the round S4 started; the round state satisfies it. */
export interface S5Round {
  readonly round: number;
  /** The commit S4 judged. S5 audits the candidate's head, and the two must be one commit. */
  readonly candidate_sha: string;
  /** Written here, read by S6: a round that already carries a known-flawed signal does not spend the one-shot test split. */
  flawed_signal: boolean;
}

export interface S5Deps {
  location: ProjectLocation;
  candidates: CandidateSource;
  /** The feedback released so far is one of the six canary surfaces. */
  feedback: Pick<FeedbackSlot, "released">;
  round: () => S5Round | null;
  /** The only place candidate code runs. Production: `containerWorkCopies`. */
  copies: (ctx: StationContext, contract: InterfaceContract) => Promise<WorkCopyFactory>;
  gateTimeoutMs?: number;
  /** The locked metrics' watched paths for the risk recompute; null when the goal lock cannot be read. Default: the audit of the goal. */
  watchedGlobs?: (ctx: StationContext) => readonly string[] | null;
  /** Seams for tests that watch what the station hands on. The defaults are the real functions. */
  steps?: Partial<{ runGates: typeof runGates; proveTest: typeof proveTest; runAudit: typeof runAudit }>;
}

const PROJECTION_PATHS: readonly string[] = ["spec.md", "intent.md"];
/** Built here from the quarantine and the slot, so a candidate cannot pass off its own copy of them. */
const OWN_SURFACES: readonly SurfaceKind[] = ["diff", "commit_messages", "feedback"];

const blocked = (reason_code: ReasonCode): StationResult => ({ kind: "blocked", reason_code });

function contractOf(events: readonly LedgerEvent[], scope: DecisionScope): InterfaceContract | null {
  const record = findDecision(foldDecisions(events, scope), INTERFACE_DECISION_ID);
  return record !== null && record.status === "resolved" ? record.interface : null;
}

function lockedWatchedGlobs(location: ProjectLocation, ctx: StationContext): readonly string[] | null {
  const locked = auditGoal(location, ctx.goalId, ctx.now()).locked;
  return locked === null ? null : locked.metrics.flatMap((metric) => metric.watched_paths);
}

/** A stop of the station for the errors a hostile tree or the environment can cause; anything else is a bug and propagates. */
function stopFor(error: unknown): ReasonCode | null {
  if (error instanceof WorkCopyError) return error.code === "not_golden" ? "gate_blocked" : "infra_failure";
  if (error instanceof WorkCopiesError) return "infra_failure";
  if (error instanceof HostGitError) return "gate_blocked";
  return null;
}

/** One work copy for the gates, registered with the cleanup registry and thrown away afterwards (the copy is the restore). */
async function gatesIn(
  copies: WorkCopyFactory,
  spec: { quarantine: GitTarget; sha: string },
  judge: JudgeConfigDecl,
  run: typeof runGates,
  options: Partial<RunOptions>,
): Promise<GateRunResult> {
  const copy = await copies.create(spec);
  const unregister = registerCleanup(() => copy.abortSync());
  try {
    return await run(judge.gates, copy, options);
  } finally {
    unregister();
    try {
      await copy.dispose();
    } catch {
      copy.abortSync();
    }
  }
}

/** A surface read from git objects. A failed read (an oversized diff) marks the surface incomplete, never clean. */
function gitSurface(kind: "diff" | "commit_messages", load: () => Promise<Uint8Array>): AuditSurface {
  let loaded: Promise<Uint8Array> | null = null;
  let failed = false;
  return {
    kind,
    incomplete: () => failed,
    async *read() {
      loaded ??= load();
      try {
        yield await loaded;
      } catch {
        failed = true;
      }
    },
  };
}

function surfacesOf(candidate: CandidateRef, released: readonly string[]): AuditSurface[] {
  const { quarantine, base, head } = candidate;
  return [
    gitSurface("diff", () => unifiedDiff(quarantine, base, head)),
    gitSurface("commit_messages", async () => Buffer.from(await commitMessages(quarantine, base, head), "utf8")),
    textSurface("feedback", released.join("\0")),
    ...candidate.surfaces.filter((surface) => !OWN_SURFACES.includes(surface.kind)),
  ];
}

/** An earlier round (or a person) may have moved the scenario already; marking it again is not an error and not a second event. */
function contaminate(ledger: Ledger, scope: DecisionScope, entry: CanaryIndexEntry): void {
  try {
    markScenarioStatus(ledger, scope, entry.seal_id, entry.scenario_id, "contaminated", "canary_hit");
  } catch (error) {
    if (!(error instanceof ScenarioStatusError && error.code === "already_moved")) throw error;
  }
}

/**
 * S5 (spec §5.5, §5.6): the gates, prove-test and the audit of the commit S4 judged, in this order and for this `(run, round)`.
 * Candidate code runs only in the work copies; the audit reads git objects of the quarantine and the vault, never a worktree
 * a container wrote. Everything it learns goes to the ledger first (`gates.evaluated`, `audit.completed`) and then into the
 * round's inputs, so GATE-3 and the classifier read the same facts a later reader of the ledger sees.
 */
export function s5Station(deps: S5Deps): Station {
  return {
    id: "S5",
    async run(ctx) {
      const round = deps.round();
      if (round === null || ctx.round < 1 || round.round !== ctx.round) return blocked("station_error");
      const candidate = await deps.candidates.current(ctx);
      if (candidate === null) return blocked("infra_failure");
      if (candidate.head !== round.candidate_sha) return blocked("gate_blocked");

      const ledger = new Ledger(deps.location.dir, ctx.now);
      const events = ledger.readVerified();
      const itemScope: DecisionScope = { goal_id: ctx.goalId, work_id: ctx.workId };
      const scope = { ...itemScope, run_id: ctx.runId, round: ctx.round };
      const contract = contractOf(events, itemScope);
      const watched = deps.watchedGlobs === undefined ? lockedWatchedGlobs(deps.location, ctx) : deps.watchedGlobs(ctx);
      if (contract === null || watched === null) return blocked("gate_blocked");

      // The one source of explicit test paths: this array object reaches both calls below.
      const explicit = candidate.explicitTestPaths;
      const limits = deps.gateTimeoutMs === undefined ? {} : { timeoutMs: deps.gateTimeoutMs };
      const judge = judgeConfigDecl(contract);
      let gateRun: GateRunResult;
      let prove: ProveTestResult;
      try {
        const copies = await deps.copies(ctx, contract);
        gateRun = await gatesIn(
          copies,
          { quarantine: candidate.quarantine, sha: candidate.head },
          judge,
          deps.steps?.runGates ?? runGates,
          limits,
        );
        ledger.append(gatesEvaluatedEvent(scope, gateRun));
        prove = await (deps.steps?.proveTest ?? proveTest)({
          quarantine: candidate.quarantine,
          base: candidate.base,
          head: candidate.head,
          testCommand: contract.test_command,
          explicitTestPaths: explicit,
          copies,
          ...limits,
        });
      } catch (error) {
        const code = stopFor(error);
        if (code === null) throw error;
        return blocked(code);
      }

      const listed = listVaultCanaryIndex(
        openVault(deps.location, locationEnv(deps.location)),
        ctx.workId,
        foldSeals(events, itemScope).records,
      );
      const surfaces = surfacesOf(candidate, deps.feedback.released());
      let report: WorkAudit;
      try {
        report = await (deps.steps?.runAudit ?? runAudit)({
          quarantine: candidate.quarantine,
          base: candidate.base,
          head: candidate.head,
          declaredRisk: ctx.item.front.risk,
          watchedGlobs: watched,
          extraGlobs: EXTRA_HIGH_RISK_GLOBS,
          judge,
          explicitTestPaths: explicit,
          projectionPaths: PROJECTION_PATHS,
          canaries: [...new Set([...listed.index.map((entry) => entry.canary), ...listed.unverified_canaries])].sort(),
          surfaces,
          proveTest: prove,
        });
      } catch (error) {
        const code = stopFor(error);
        if (code === null) throw error;
        return blocked(code);
      }
      // A seal whose files are missing or edited means some canaries could not be searched for: the scan is not complete.
      if (listed.unverified.length > 0) {
        report = { ...report, canary: { ...report.canary, status: "not_run", truncated: true } };
      }
      recordAudit(ledger, scope, ctx.item.dir, report, candidate.head);
      if (report.canary.total > 0) {
        for (const entry of await attributeCanaryHits(listed.index, surfaces)) contaminate(ledger, itemScope, entry);
      }

      const signals = auditSignals(report);
      ctx.inputs.gate_line = gateRun.line;
      ctx.inputs.gate_verdict = gateRun.verdict.status;
      ctx.inputs.audit = auditInputsOf(report);
      ctx.inputs.high_risk_paths_touched = report.high_risk_paths_touched;
      ctx.inputs.isolation_level = loadRunIsolation(ctx.item.dir, scope, ledger.readVerified()).level;
      round.flawed_signal =
        gateRun.verdict.status !== "GREEN" ||
        prove.status !== "PROVEN" ||
        signals.flawed.length > 0 ||
        signals.judge_config_touched;
      return {
        kind: "ok",
        progress_digest: sha256Hex(
          canonicalize({ head: candidate.head, line: gateRun.line, audit: auditPayloadOf(report) }),
        ),
      };
    },
  };
}
