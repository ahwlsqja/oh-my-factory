import { randomBytes } from "node:crypto";
import { join, relative } from "node:path";
import type { RunnerKind } from "../adapters/measure-cmd.js";
import type { Reconciler } from "../adapters/reconciler.js";
import { createMarkdownStore } from "../adapters/state-markdown.js";
import { budgetState } from "../core/budget.js";
import { type OmfConfig, REFRESH, STOP_IF_UNREVIEWED_EVIDENCE, configSha256 } from "../core/config.js";
import { Ledger, type LedgerEvent } from "../core/ledger.js";
import type { ProjectLocation } from "../core/paths.js";
import { writePrivateFile } from "../core/private-fs.js";
import { claimStatus } from "../work/claim.js";
import { verifiedItems } from "../work/ledger-verify.js";
import { OPEN_STATES, type RiskClass, type WorkItem, type WorkState } from "../work/types.js";
import { auditGoal } from "./audit.js";
import { parseDuration } from "./duration.js";
import { summarizeGap } from "./gap-summary.js";
import { commitsSince } from "./git.js";
import { goalDir, readGoal } from "./goal-file.js";
import { latestApproval } from "./goal-lock.js";
import { escalate, nextSteps, terminate } from "./lifecycle.js";
import { type GapReport, GoalStopError, measureGoal } from "./measure.js";
import { type CandidateRejection, reconcileGoal } from "./reconcile.js";
import { evaluateStaleness } from "./refresh.js";
import { type Escalation, type RunState, type Termination, runStateFromEvents } from "./run-state.js";
import {
  type Station,
  type StationOutcome,
  previousProgressSig,
  progressSignature,
  signatureCounts,
  signatureOf,
  tripped,
} from "./signatures.js";
import { isMarkedStale } from "./stale-mark.js";
import { evaluateSuccess } from "./success.js";
import { withTickLock } from "./tick-lock.js";

export type TickStatus = "continue" | Termination;
export type TickOutcome =
  | "dispatched"
  | "no_candidates"
  | "wip_full"
  | "back_pressure"
  | "observing"
  | "idle"
  | "success_candidate"
  | "stopped"
  | "escalated"
  | "already_final"
  | "stopped_until_resumed"
  | "failed";

export interface TickOptions {
  runner: RunnerKind;
  reconciler: Reconciler;
  config: OmfConfig;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  /** Default `t-<yyyymmdd>T<hhmmss>Z-<4 hex>`; tests inject a counter. */
  newTickId?: (now: Date) => string;
}

export interface TickResult {
  tick_id: string;
  goal_id: string;
  status: TickStatus;
  outcome: TickOutcome;
  reason_code: string | null;
  escalation: Escalation | null;
  next_steps: string[];
  /** Work ids of open items in awaiting_approval; the CLI exits 1 while this is non-empty. */
  awaiting_approval: string[];
  /** The model answered with a usable envelope; the basis of the stall comparison. */
  reconciled: boolean;
  created: { work_id: string; title: string; state: WorkState; risk: RiskClass }[];
  rejected: CandidateRejection[];
  signatures: string[];
  progress_sig: string | null;
  stage_ms: Partial<Record<Station, number>>;
  /** Relative path of reports/<stamp>-tick.md; null when the tick wrote nothing. */
  report: string | null;
}

interface TickState {
  status: TickStatus;
  outcome: TickOutcome;
  reason: string | null;
  escalation: Escalation | null;
  outcomes: StationOutcome[];
  created: TickResult["created"];
  rejected: CandidateRejection[];
  modelCalls: 0 | 1;
  reconciled: boolean;
  progressSig: string | null;
  stageMs: Partial<Record<Station, number>>;
  /** The goal run ended or blocked during this tick, so nothing after it (refresh) applies. */
  terminated: boolean;
}

interface HumanLines {
  target: string | null;
  gapLine: string | null;
}

function compactUtc(at: Date): string {
  return at
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
}

function defaultTickId(at: Date): string {
  return `t-${compactUtc(at)}-${randomBytes(2).toString("hex")}`;
}

function elapsed(since: number): number {
  return Math.round(performance.now() - since);
}

function blankResult(goalId: string, tickId: string): TickResult {
  return {
    tick_id: tickId,
    goal_id: goalId,
    status: "continue",
    outcome: "idle",
    reason_code: null,
    escalation: null,
    next_steps: [],
    awaiting_approval: [],
    reconciled: false,
    created: [],
    rejected: [],
    signatures: [],
    progress_sig: null,
    stage_ms: {},
    report: null,
  };
}

/** A goal run that already ended or is waiting for a person: nothing is measured or written. */
function standing(goalId: string, tickId: string, run: RunState): TickResult {
  const final = run.status === "finish" || run.status === "cancelled";
  const steps =
    run.open_escalation !== null
      ? nextSteps(run.open_escalation, goalId)
      : run.status === "failed"
        ? [`omf goal resume ${goalId}`]
        : [];
  return {
    ...blankResult(goalId, tickId),
    status: run.status === "running" ? "continue" : run.status,
    outcome: final ? "already_final" : "stopped_until_resumed",
    reason_code: run.reason_code,
    escalation: run.open_escalation,
    next_steps: steps,
  };
}

/**
 * The human tick report. It is host state only and may hold the target line and the gap; the CLI output of
 * the tick never does. Every dispatched item gets its veto command (spec §4.4 step 5).
 */
export function renderTickReport(result: TickResult, human: HumanLines): string {
  const lines = [
    `# Tick ${result.tick_id} for ${result.goal_id}`,
    "",
    `- Outcome: ${result.outcome} (${result.status})`,
  ];
  if (result.reason_code !== null) lines.push(`- Reason: ${result.reason_code}`);
  if (human.target !== null) lines.push(`- Target: ${human.target}`);
  if (human.gapLine !== null) lines.push(`- Gap: ${human.gapLine}`);
  if (result.created.length > 0) {
    lines.push("", "## Dispatched work items", "");
    for (const item of result.created) {
      lines.push(`- ${item.work_id} (${item.state}, risk ${item.risk}): ${item.title}`);
      lines.push(`  veto with \`omf veto ${item.work_id}\``);
    }
  }
  if (result.awaiting_approval.length > 0) {
    lines.push("", "## Awaiting approval", "");
    for (const id of result.awaiting_approval) lines.push(`- ${id}: \`omf work approve ${id}\``);
  }
  if (result.rejected.length > 0) {
    lines.push("", "## Rejected candidates", "");
    for (const r of result.rejected) lines.push(`- candidate ${r.index}: ${r.filter} (${r.reason_code})`);
  }
  if (result.next_steps.length > 0) {
    lines.push("", "## Next steps", "");
    for (const step of result.next_steps) lines.push(`- ${step}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The stall test (spec §4.4 "no progress"). The state a tick sees is the same as the state the
 * previous model ANSWER saw, so asking again cannot help; a live claim means a W run is working on an open
 * item, which is progress the signature cannot see. `previous` is null when no tick since the last resume
 * or approval got an answer, and a failed model call sets no baseline, so a failure is retried.
 */
export function isStalled(args: { progress: string; previous: string | null; liveClaim: boolean }): boolean {
  return args.previous !== null && args.progress === args.previous && !args.liveClaim;
}

/** True when a W run holds `claim.lock` on an open item (the claim of a dead process is stale and does not count). */
function hasLiveClaim(items: readonly WorkItem[]): boolean {
  return items.some((item) => {
    if (!OPEN_STATES.includes(item.front.state)) return false;
    const claim = claimStatus(item.dir);
    return claim.held && !claim.stale;
  });
}

/**
 * The id of the latest earlier tick that wrote goal.tick_started and then neither goal.tick_ended nor a
 * goal.terminated (a crash or kill after the tick began), or null. Only the latest start is looked at, so one
 * crash is counted by exactly one later tick. A tick that was terminated on purpose (internal_error, or an
 * escalation whose goal.tick_ended never landed) is not an interrupted one.
 */
function interruptedTick(prior: readonly LedgerEvent[], goalId: string): string | null {
  let latest: string | null = null;
  for (const event of prior) {
    const tickId = event.payload.tick_id;
    if (event.type === "goal.tick_started" && event.payload.goal_id === goalId && typeof tickId === "string")
      latest = tickId;
  }
  if (latest === null) return null;
  const closed = prior.some(
    (event) =>
      event.payload.goal_id === goalId &&
      event.payload.tick_id === latest &&
      (event.type === "goal.tick_ended" || event.type === "goal.terminated"),
  );
  return closed ? null : latest;
}

/**
 * The id of a tick that wrote goal.tick_started but no goal.tick_ended among `events`, or null. `events` is
 * only what this call appended, so an older crashed tick is never blamed on a call that failed earlier.
 */
function unfinishedTick(events: readonly LedgerEvent[], goalId: string): string | null {
  let started: string | null = null;
  const ended = new Set<string>();
  for (const event of events) {
    const tickId = event.payload.tick_id;
    if (event.payload.goal_id !== goalId || typeof tickId !== "string") continue;
    if (event.type === "goal.tick_started") started = tickId;
    if (event.type === "goal.tick_ended") ended.add(tickId);
  }
  return started !== null && !ended.has(started) ? started : null;
}

/**
 * A machine fault after the tick mutated state must not be retried silently: the goal is terminated
 * `failed` and only a person's resume clears it. A final termination (finish, cancelled) is left alone.
 * Failing to write this record (a corrupt ledger, say) is swallowed: the original error is the one to report.
 */
function recordInternalError(location: ProjectLocation, goalId: string, seenBefore: number): void {
  try {
    const ledger = new Ledger(location.dir);
    const events = ledger.readVerified().slice(seenBefore);
    const final = events.some(
      (event) =>
        event.type === "goal.terminated" &&
        event.payload.goal_id === goalId &&
        (event.payload.state === "finish" || event.payload.state === "cancelled"),
    );
    const tickId = unfinishedTick(events, goalId);
    if (tickId !== null && !final) terminate(ledger, goalId, "failed", tickId, "internal_error");
  } catch {
    // see the doc comment
  }
}

/**
 * One pass of the goal loop (spec §4.4), design §10. A tick uses a round only when it calls the reconciler
 *: waiting ticks, gate stops and failed audits use none. One tick per goal at a time.
 */
export function tickGoal(location: ProjectLocation, goalId: string, options: TickOptions): Promise<TickResult> {
  return withTickLock(location, goalId, async () => {
    const seenBefore = new Ledger(location.dir).readVerified().length;
    try {
      return await runTick(location, goalId, options);
    } catch (err) {
      // An exception after goal.tick_started terminates the goal `failed` and still reaches the caller (exit 2).
      recordInternalError(location, goalId, seenBefore);
      throw err;
    }
  });
}

async function runTick(location: ProjectLocation, goalId: string, options: TickOptions): Promise<TickResult> {
  const now = options.now ?? ((): Date => new Date());
  const ledger = new Ledger(location.dir, now);
  const store = createMarkdownStore(location.dir);
  const prior = ledger.readVerified();
  const run = runStateFromEvents(prior, goalId);
  const tickId = (options.newTickId ?? defaultTickId)(now());
  if (run.status !== "running") return standing(goalId, tickId, run);
  const interrupted = interruptedTick(prior, goalId);

  ledger.append({
    actor: "omf",
    type: "goal.tick_started",
    payload: {
      goal_id: goalId,
      tick_id: tickId,
      regime: latestApproval(prior, goalId)?.regime ?? 0,
      runner: options.runner,
      config_sha256: configSha256(location.dir),
    },
  });

  const st: TickState = {
    status: "continue",
    outcome: "idle",
    reason: null,
    escalation: null,
    outcomes: [],
    created: [],
    rejected: [],
    modelCalls: 0,
    reconciled: false,
    progressSig: null,
    stageMs: {},
    terminated: false,
  };
  // A predecessor that crashed after goal.tick_started counts as a failure for the breaker, once (design §6).
  if (interrupted !== null)
    st.outcomes.push({ station: "dispatch", outcome_class: "failed", reason: "tick.interrupted" });
  let human: HumanLines = { target: null, gapLine: null };

  const escalateTick = (code: string, signature: string | null): void => {
    st.escalation = escalate(ledger, goalId, tickId, code, signature);
    st.status = "blocked_on_user";
    st.outcome = "escalated";
    st.reason = code;
    st.terminated = true;
  };

  /** Self-metrics, the report and goal.tick_ended (spec §12). Every path after goal.tick_started ends here. */
  const finishTick = (): TickResult => {
    const signatures = st.outcomes
      .map((outcome) => signatureOf(outcome, st.progressSig))
      .filter((signature): signature is string => signature !== null);
    // Signature breaker: three hits of one signature since the last resume or approval stop the goal for a
    // person. A termination this tick already made (finish, or an escalation) is not overridden.
    if (st.status === "continue" && st.escalation === null) {
      const hit = tripped(signatureCounts(prior, goalId), signatures);
      if (hit !== null) escalateTick("repeated_signature", hit);
    }
    const items = verifiedItems(store, ledger.readVerified(), goalId);
    const awaiting = items.items
      .filter((item) => item.front.state === "awaiting_approval")
      .map((item) => item.front.work_id);
    const steps = new Set<string>(st.escalation === null ? [] : nextSteps(st.escalation, goalId));
    for (const id of awaiting) steps.add(`omf work approve ${id}`);
    if (items.malformed.length > 0) steps.add(`omf work list ${goalId}`);
    const result: TickResult = {
      ...blankResult(goalId, tickId),
      status: st.status,
      outcome: st.outcome,
      reason_code: st.reason ?? (interrupted === null ? null : "tick.interrupted"),
      escalation: st.escalation,
      next_steps: [...steps],
      awaiting_approval: awaiting,
      reconciled: st.reconciled,
      created: st.created,
      rejected: st.rejected,
      signatures,
      progress_sig: st.progressSig,
      stage_ms: st.stageMs,
    };
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    const file = join(goalDir(location.dir, goalId), "reports", `${stamp}-tick.md`);
    writePrivateFile(file, renderTickReport(result, human));
    result.report = relative(location.dir, file);
    ledger.append({
      actor: "omf",
      type: "goal.tick_ended",
      payload: {
        goal_id: goalId,
        tick_id: tickId,
        status: result.status,
        outcome: result.outcome,
        reason_code: result.reason_code,
        progress_sig: result.progress_sig,
        signatures,
        stage_ms: result.stage_ms,
        model_calls: st.modelCalls,
        reconciled: st.reconciled,
        created: result.created.length,
        rounds_remaining: budgetState(ledger, goalId, "rounds")?.remaining ?? null,
        report: result.report,
      },
    });
    return result;
  };

  // Gates. A draft or a regime change is a J1 question; a lock that does not verify stops the line (E1).
  const auditStart = performance.now();
  const audit = auditGoal(location, goalId, now());
  st.stageMs.audit = elapsed(auditStart);
  if (audit.state === "draft") {
    escalateTick("goal_not_approved", null);
    return finishTick();
  }
  if (audit.problems.length > 0 || audit.locked === null || audit.approval === null) {
    const reasons = audit.problems.length > 0 ? audit.problems : ["goal locks could not be verified"];
    ledger.append({ actor: "omf", type: "goal.audit_failed", payload: { goal_id: goalId, reasons } });
    st.outcomes.push({ station: "audit", outcome_class: "stopped", reason: reasons.join("; ") });
    st.outcome = "stopped";
    st.reason = "audit_failed";
    return finishTick();
  }
  const { locked, approval } = audit;
  if (audit.regime_changes.length > 0) {
    // A stale mark is the only regime change the tick itself causes; it gets its own question.
    const stale = audit.regime_changes.every((reason) => reason.startsWith("goal marked stale"));
    escalateTick(stale ? "stale_goal" : "reapproval_required", null);
    return finishTick();
  }
  if (audit.wall_time_exceeded) {
    escalateTick("wall_time_exceeded", null);
    return finishTick();
  }

  // Measure (steps 2 and 3). A fault here uses no round: the model has not been called.
  const measureStage = async (): Promise<GapReport | null> => {
    const started = performance.now();
    try {
      const { report } = await measureGoal(location, goalId, { runner: options.runner, now, env: options.env });
      return report;
    } catch (err) {
      if (!(err instanceof GoalStopError)) throw err;
      st.outcomes.push({ station: "measure", outcome_class: "stopped", reason: err.reasons.join("; ") });
      st.outcome = "stopped";
      st.reason = "measure_stopped";
      return null;
    } finally {
      st.stageMs.measure = elapsed(started);
    }
  };
  const report = await measureStage();
  if (report === null) return finishTick();
  const t = report.target;
  human = {
    target: `${t.metric_id} ${t.operator} ${t.value} ${t.unit}; measured ${t.measured ?? "n/a"}`,
    gapLine: t.result === null ? null : t.result.met ? "target met" : `${t.result.direction}, ${t.result.size}`,
  };
  if (t.measured === null || t.result === null) {
    const failure = report.metrics.find((m) => m.metric_id === t.metric_id)?.failure ?? "no value";
    st.outcomes.push({ station: "measure", outcome_class: "failed", reason: failure });
    st.outcome = "stopped";
    st.reason = "measure_failed";
    return finishTick();
  }

  // The state the model would be asked about: verified items and this tick's measurements.
  const events = ledger.readVerified();
  const verified = verifiedItems(store, events, goalId);
  st.progressSig = progressSignature({
    regime: approval.regime,
    items: verified.items.map((item) => ({
      work_id: item.front.work_id,
      state: item.front.state,
      updated_at: item.front.updated_at,
    })),
    metrics: report.metrics.map((m) => ({ metric_id: m.metric_id, value: m.value })),
  });

  const { summary, none } = summarizeGap(report, locked.goal.semantic.mode);
  if (summary === null) {
    // No trigger: no model call, no work item and no round.
    if (none?.reason === "target_met") {
      const minObservationMs = parseDuration(locked.goal.semantic.prereg.min_observation);
      const verdict = evaluateSuccess({ events, goalId, regime: approval.regime, minObservationMs, now: now() });
      if (verdict.kind === "candidate") {
        ledger.append({
          actor: "omf",
          type: "goal.success_candidate",
          payload: {
            goal_id: goalId,
            tick_id: tickId,
            regime: approval.regime,
            first_met_at: verdict.first_met_at,
            consecutive: verdict.consecutive,
            min_observation_ms: minObservationMs,
            attribution: verdict.attribution,
            correlational: true,
          },
        });
        terminate(ledger, goalId, "finish", tickId, "success_candidate");
        st.status = "finish";
        st.outcome = "success_candidate";
        st.reason = "success_candidate";
        st.terminated = true;
      } else {
        st.outcome = "observing";
        st.reason = verdict.missing[0] ?? "undetermined";
      }
    } else {
      st.outcome = "idle";
      st.reason = "no_breach";
    }
  } else {
    // A repairable item is one W edge behind the ledger (a crash between the event and the file).
    // STOP_IF reads it by its ledger target and the WIP cap by its file state (always open, see reconcile.ts),
    // so a crash can neither hide unreviewed evidence nor free a slot that is taken.
    const openCount =
      verified.items.filter((item) => OPEN_STATES.includes(item.front.state)).length + verified.repairable.length;
    const awaitingReview =
      verified.items.filter((item) => item.front.state === "awaiting_review").length +
      verified.repairable.filter((entry) => entry.repair_to === "awaiting_review").length;
    if (awaitingReview >= STOP_IF_UNREVIEWED_EVIDENCE) {
      st.outcome = "back_pressure";
      st.reason = "stop_if_unreviewed_evidence";
    } else if (openCount >= locked.goal.semantic.budget.max_open_work_items) {
      st.outcome = "wip_full";
      st.reason = "max_open_work_items";
    } else if (
      st.progressSig !== null &&
      isStalled({
        progress: st.progressSig,
        previous: previousProgressSig(events, goalId),
        liveClaim: hasLiveClaim(verified.items),
      })
    ) {
      // Only right before a model call, after back_pressure and wip_full: a tick that waits is never a stall.
      escalateTick("no_progress", null);
    } else {
      const doc = readGoal(location.dir, goalId);
      const r = await reconcileGoal({
        location,
        ledger,
        store,
        reconciler: options.reconciler,
        config: options.config,
        goalId,
        tickId,
        front: doc.front,
        body: doc.body,
        locked,
        summary,
        now,
      });
      st.stageMs.reconcile = r.stage_ms.reconcile;
      st.stageMs.dispatch = r.stage_ms.dispatch;
      st.rejected = r.rejected;
      switch (r.outcome) {
        case "dispatched":
          st.modelCalls = 1;
          st.reconciled = true;
          st.outcome = "dispatched";
          st.created = r.created.map((item) => ({
            work_id: item.front.work_id,
            title: item.front.title,
            state: item.front.state,
            risk: item.front.risk.class,
          }));
          st.outcomes.push({ station: "reconcile", outcome_class: "ok", reason: "responded" });
          st.outcomes.push({ station: "dispatch", outcome_class: "ok", reason: "created" });
          break;
        case "no_candidates": {
          st.modelCalls = 1;
          st.reconciled = true;
          st.outcome = "no_candidates";
          st.reason = "no_candidates";
          const filters = [...new Set(r.rejected.map((rejection) => rejection.filter))].sort();
          st.outcomes.push({ station: "reconcile", outcome_class: "empty", reason: filters.join(",") || "none" });
          break;
        }
        case "model_failed": {
          st.modelCalls = 1;
          st.outcome = "stopped";
          st.reason = r.failure?.code ?? "model_failed";
          st.outcomes.push({ station: "reconcile", outcome_class: "failed", reason: st.reason });
          break;
        }
        case "approach_unusable":
        case "rounds_exhausted":
        case "disclosure_exhausted":
          escalateTick(r.outcome, null);
          break;
      }
    }
  }

  // Refresh (step 6): deterministic staleness. The mark is read by the next tick's audit, never by this one.
  if (!st.terminated) {
    const refreshStart = performance.now();
    const after = ledger.readVerified();
    if (!isMarkedStale(after, goalId)) {
      const target = locked.goal.semantic.target;
      const firstMeasured = after.find(
        (event) =>
          event.type === "metric.measured" &&
          event.payload.goal_id === goalId &&
          event.payload.metric_id === target.metric_id &&
          event.payload.regime === approval.regime &&
          event.payload.needs_reapproval === false &&
          typeof event.payload.value === "number",
      )?.payload.value;
      let commits: number | null;
      try {
        commits = commitsSince(location.repo, approval.head_commit);
      } catch {
        commits = null;
      }
      const verdict = evaluateStaleness({
        approval,
        config: REFRESH,
        now: now(),
        commitsSince: commits,
        targetFirst: typeof firstMeasured === "number" ? firstMeasured : null,
        targetLatest: t.measured,
        targetOperator: target.operator,
        targetMet: t.result.met,
      });
      if (verdict.stale) {
        ledger.append({
          actor: "omf",
          type: "goal.stale",
          payload: {
            goal_id: goalId,
            tick_id: tickId,
            regime: approval.regime,
            tripped: verdict.tripped,
            signals: verdict.signals,
          },
        });
      }
    }
    st.stageMs.refresh = elapsed(refreshStart);
  }
  return finishTick();
}
