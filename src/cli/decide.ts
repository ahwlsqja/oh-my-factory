import { existsSync, readFileSync } from "node:fs";
import type { Command } from "commander";
import { findWorkItem } from "../adapters/state-markdown.js";
import { Ledger, type LedgerEvent } from "../core/ledger.js";
import type { ProjectLocation } from "../core/paths.js";
import { requireProject } from "../core/project.js";
import { validateDef } from "../core/schema.js";
import { type Gate1Reason, type Gate1Result, evaluateGate1, intentQuestionIds } from "../decision/gate1.js";
import { type LeakContext, loadLeakContext } from "../decision/leak-lint.js";
import { type DecisionLinks, type LintProblem, lintDecisions } from "../decision/lint.js";
import { needsHumanFile, syncNeedsHuman } from "../decision/needs-human.js";
import { renderSpec, specStatus, writeSpec } from "../decision/spec-md.js";
import { foldDecisions } from "../decision/state.js";
import type {
  AddInput,
  DecisionClass,
  DecisionScope,
  DecisionState,
  DecisionStatus,
  DeferInput,
  NaInput,
  ResolveInput,
} from "../decision/types.js";
import {
  DecisionError,
  type WriteContext,
  addDecision,
  deferDecision,
  markNotApplicable,
  resolveDecision,
} from "../decision/write.js";
import { assertLineSafe } from "../vault/line-guard.js";
import { claimStatus, withItemLock } from "../work/claim.js";
import { verifyItemAgainstLedger } from "../work/ledger-verify.js";
import type { WorkItem } from "../work/types.js";

export interface DecideReport {
  state: DecisionState;
  gate: Gate1Result;
  problems: LintProblem[];
  spec: "ok" | "missing" | "drift";
}

function scopeOf(item: WorkItem): DecisionScope {
  return { goal_id: item.front.goal_id, work_id: item.front.work_id };
}

/**
 * The item, when it exists and the ledger accounts for it (spec §6.2: a hand-edited item is never acted
 * on). Reading verifies the hash chain, so a corrupt ledger throws here, before anything else happens.
 */
function loadConsistentItem(location: ProjectLocation, workId: string): WorkItem {
  const item = findWorkItem(location.dir, workId);
  if (item === null) throw new Error(`unknown work item ${workId}`);
  const verdict = verifyItemAgainstLedger(item.front, new Ledger(location.dir).readVerified());
  if (!verdict.ok) {
    throw new Error(`work item ${workId} is malformed (${verdict.reason}); no decision was read or changed`);
  }
  return item;
}

/**
 * The guard of every write: the item is ledger-consistent, in `ready` and nothing more, and no run holds
 * its claim. A run starts an item only at S3, after GATE-1 passed (M3b1-D11), so an `in_progress` item has
 * a sealed `spec.md`: changing a decision now would drift from the spec its run holds. A J2 question
 * raised after the start has no write path until a later milestone relaxes this guard (M3b1 deferred).
 * Decisions must not change while a run holds the claim either (M3a design A12). Plain errors: exit 2.
 */
export function requireDecidableItem(location: ProjectLocation, workId: string): WorkItem {
  // Spec §11 rule 4: a write while sealed material sits in the repository or an OMF worktree is refused before it
  // reads or appends anything. Every decide write goes through this function.
  assertLineSafe(location);
  const item = loadConsistentItem(location, workId);
  if (item.front.state !== "ready") {
    throw new Error(`work item ${workId} is ${item.front.state}; decisions can be changed only while it is ready`);
  }
  if (claimStatus(item.dir).held) {
    throw new Error(`work item ${workId} is claimed by a run; decisions cannot change while it runs`);
  }
  return item;
}

interface Snapshot {
  scope: DecisionScope;
  state: DecisionState;
  leak: LeakContext;
  questionIds: string[];
  gate: Gate1Result;
}

/** Folds the verified ledger once and evaluates GATE-1 on it. Fails closed when the goal lock is missing. */
function snapshotOf(location: ProjectLocation, item: WorkItem, now: Date): Snapshot {
  const events = new Ledger(location.dir).readVerified();
  const scope = scopeOf(item);
  const leak = loadLeakContext(location.dir, scope.goal_id, events);
  const state = foldDecisions(events, scope);
  const questionIds = intentQuestionIds(item.intent.candidate.open_questions.length);
  const gate = evaluateGate1(state, now, { leak, intentQuestionIds: questionIds });
  return { scope, state, leak, questionIds, gate };
}

function reportOf(location: ProjectLocation, item: WorkItem, now: Date, links?: DecisionLinks): DecideReport {
  const snap = snapshotOf(location, item, now);
  const problems = lintDecisions(snap.state, snap.leak, snap.questionIds, links);
  const expected = renderSpec(snap.state, { title: item.front.title }, snap.leak);
  const spec = specStatus(item.dir, expected);
  if (spec === "drift") problems.push({ code: "spec_drift", decision_id: null });
  // An item nobody has written to has no spec.md yet, and that is not a problem.
  if (spec === "missing" && snap.state.decisions.length > 0) problems.push({ code: "spec_missing", decision_id: null });
  return { state: snap.state, gate: snap.gate, problems, spec };
}

/** Read-only: folds, lints, evaluates GATE-1 and compares `spec.md`. Writes nothing. */
export function decideReport(
  location: ProjectLocation,
  workId: string,
  now: Date,
  links?: DecisionLinks,
): DecideReport {
  return reportOf(location, loadConsistentItem(location, workId), now, links);
}

/**
 * Rewrites `spec.md` from the ledger and refreshes `needs-human.json` when one exists. The ledger is
 * re-read inside the item lock, so two concurrent writers cannot leave the older projection last (A10).
 */
function refreshProjection(location: ProjectLocation, item: WorkItem, now: Date): void {
  withItemLock(item.dir, () => {
    const snap = snapshotOf(location, item, now);
    writeSpec(item.dir, renderSpec(snap.state, { title: item.front.title }, snap.leak));
    // No stale block outlives a resolve: only an existing J2 record is refreshed, a first one comes from `lint`.
    if (existsSync(needsHumanFile(item.dir))) syncNeedsHuman(item.dir, snap.scope, snap.gate, now);
  });
}

/**
 * The common spine of the four verbs. The ledger event comes first, then the projection (A10): a crash in
 * between leaves a stale `spec.md` that `lint` reports and the next write fixes. A writer that throws
 * (a refusal, a leak) leaves `spec.md` alone, because nothing in the folded state changed.
 */
function runWrite(
  location: ProjectLocation,
  workId: string,
  now: Date,
  write: (ledger: Ledger, scope: DecisionScope, ctx: WriteContext) => LedgerEvent,
): { event: LedgerEvent } {
  const item = requireDecidableItem(location, workId);
  const ledger = new Ledger(location.dir);
  const scope = scopeOf(item);
  const leak = loadLeakContext(location.dir, scope.goal_id, ledger.readVerified());
  const ctx: WriteContext = { leak, intentQuestions: item.intent.candidate.open_questions, now };
  const event = write(ledger, scope, ctx);
  refreshProjection(location, item, now);
  return { event };
}

// The CLI passes `omf` for add and `humanActor` for the rest; tests pass whatever actor they are proving.
export function runDecideAdd(
  location: ProjectLocation,
  workId: string,
  input: AddInput,
  actor: string,
  now: Date = new Date(),
): { event: LedgerEvent } {
  return runWrite(location, workId, now, (ledger, scope, ctx) => addDecision(ledger, scope, input, actor, ctx));
}

export function runDecideResolve(
  location: ProjectLocation,
  workId: string,
  decisionId: string,
  input: ResolveInput,
  actor: string,
  now: Date = new Date(),
): { event: LedgerEvent } {
  return runWrite(location, workId, now, (ledger, scope, ctx) =>
    resolveDecision(ledger, scope, decisionId, input, actor, ctx),
  );
}

export function runDecideDefer(
  location: ProjectLocation,
  workId: string,
  decisionId: string,
  input: DeferInput,
  actor: string,
  now: Date = new Date(),
): { event: LedgerEvent } {
  return runWrite(location, workId, now, (ledger, scope, ctx) =>
    deferDecision(ledger, scope, decisionId, input, actor, ctx),
  );
}

export function runDecideNa(
  location: ProjectLocation,
  workId: string,
  decisionId: string,
  input: NaInput,
  actor: string,
  now: Date = new Date(),
): { event: LedgerEvent } {
  return runWrite(location, workId, now, (ledger, scope, ctx) =>
    markNotApplicable(ledger, scope, decisionId, input, actor, ctx),
  );
}

/** Exit code of `omf decide lint` when GATE-1 blocks on a person (J2): not "problems found", not "could not run". */
export const EXIT_BLOCKED = 3;

/** 1 when lint found problems (also when a block coexists with them), else 3 when blocked, else 0. */
export function lintExitCode(report: DecideReport): 0 | 1 | 3 {
  if (report.problems.length > 0) return 1;
  return report.gate.status === "blocked_on_user" ? EXIT_BLOCKED : 0;
}

/**
 * Reads a `--file` and checks it against one definition of decision.schema.json. Every failure is a
 * `DecisionError("invalid_input")`, so a bad file is a refusal (exit 1) with or without a terminal. The
 * message names the file and the schema errors, never the file's content.
 */
function readInput<T>(path: string, def: string): T {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new DecisionError("invalid_input", `cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? "error"}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new DecisionError("invalid_input", `${path} is not valid JSON`);
  }
  const checked = validateDef("decision.schema.json", def, data);
  if (!checked.ok) throw new DecisionError("invalid_input", `${path} does not match ${def}: ${checked.errors}`);
  return data as T;
}

/** A `DecisionError` is a refusal: its message, exit 1. Anything else is not caught and ends as exit 2 in main.ts. */
function refusing(run: () => void): void {
  try {
    run();
  } catch (err) {
    if (!(err instanceof DecisionError)) throw err;
    console.error(err.message);
    process.exitCode = 1;
  }
}

interface ShownReason {
  code: Gate1Reason["code"];
  decision_id: string | null;
  detail: string | null;
}

interface ShownReport {
  work_id: string;
  title: string;
  gate: Gate1Result["status"];
  reasons: ShownReason[];
  problems: LintProblem[];
  spec: DecideReport["spec"];
  decisions: { id: string | null; class: DecisionClass; status: DecisionStatus; added_seq: number }[];
}

/**
 * What a person sees: ids, codes and statuses, never decision text. The id of a record that leaks under the
 * current goal lock is replaced by null everywhere (A16b), exactly as `spec.md` withholds that record.
 */
function shownReport(report: DecideReport, item: WorkItem): ShownReport {
  const hidden = new Set<string>();
  for (const problem of report.problems) {
    if (problem.code === "leak" && problem.decision_id !== null) hidden.add(problem.decision_id);
  }
  const reasons = report.gate.status === "pass" ? [] : report.gate.reasons;
  for (const reason of reasons) {
    if (reason.code === "record_invalid" && reason.decision_id !== null) hidden.add(reason.decision_id);
  }
  const mask = (id: string | null): string | null => (id !== null && hidden.has(id) ? null : id);
  return {
    work_id: item.front.work_id,
    title: item.front.title,
    gate: report.gate.status,
    reasons: reasons.map((reason) => {
      const id = "decision_id" in reason ? reason.decision_id : null;
      const detail =
        reason.code === "deferral_expired"
          ? reason.expires_at
          : reason.code === "record_invalid"
            ? reason.problem
            : reason.code === "ledger_anomaly"
              ? reason.anomaly
              : null;
      return { code: reason.code, decision_id: mask(id), detail };
    }),
    problems: report.problems.map((problem) => ({ ...problem, decision_id: mask(problem.decision_id) })),
    spec: report.spec,
    decisions: report.state.decisions.map((d) => ({
      id: mask(d.id),
      class: d.class,
      status: d.status,
      added_seq: d.added_seq,
    })),
  };
}

function reportLines(shown: ShownReport): string[] {
  const lines = [`decisions of ${shown.work_id}: ${shown.title}`];
  if (shown.decisions.length === 0) lines.push("  none yet");
  for (const d of shown.decisions) {
    lines.push(`  ${(d.id ?? `(withheld #${d.added_seq})`).padEnd(24)} ${d.class.padEnd(15)} ${d.status}`);
  }
  lines.push(shown.gate === "pass" ? "GATE-1: pass" : "GATE-1: blocked_on_user (J2)");
  for (const reason of shown.reasons) {
    lines.push(
      `  - ${reason.code}${reason.decision_id === null ? "" : ` ${reason.decision_id}`}${reason.detail === null ? "" : ` (${reason.detail})`}`,
    );
  }
  if (shown.problems.length === 0) {
    lines.push("lint: clean");
  } else {
    lines.push(`lint: ${shown.problems.length} problem(s)`);
    for (const problem of shown.problems) {
      const parts = [problem.field, problem.rule, problem.detail].filter((part): part is string => part !== undefined);
      lines.push(
        `  - ${problem.code}${problem.decision_id === null ? "" : ` ${problem.decision_id}`}${parts.length === 0 ? "" : ` (${parts.join(", ")})`}`,
      );
    }
  }
  lines.push(`spec.md: ${shown.spec}`);
  return lines;
}

function printReport(shown: ShownReport, json: boolean): void {
  if (json) console.log(JSON.stringify(shown, null, 2));
  else for (const line of reportLines(shown)) console.log(line);
}

/**
 * `omf decide add|lint|show` (spec §9). `resolve` and `defer` are registered in Task 10, behind a terminal
 * and a retype. Errors other than `DecisionError` propagate to main.ts, which exits 2.
 */
export function registerDecideCommands(program: Command): void {
  const decide = program
    .command("decide")
    .description("record the design decisions of a work item, lint them and read GATE-1 (J2)");

  decide
    .command("add")
    .argument("<work_id>")
    .requiredOption(
      "--file <entry.json>",
      "the question to record: id, class, question, optional qas and response_measure",
    )
    .description("record a design question as an open decision and rewrite spec.md")
    .action((workId: string, options: { file: string }) => {
      const location = requireProject(process.cwd());
      refusing(() => {
        requireDecidableItem(location, workId); // the item first, then the file (A20)
        const input = readInput<AddInput>(options.file, "add_input");
        const { event } = runDecideAdd(location, workId, input, "omf");
        console.log(`added ${input.id} to ${workId} (ledger seq ${event.seq})`);
      });
    });

  decide
    .command("lint")
    .argument("<work_id>")
    .option("--json", "print the report as JSON")
    .option("--render", "rewrite spec.md from the ledger first")
    .description("lint the decisions and evaluate GATE-1; exit 0 clean, 1 problems, 3 blocked on a person (J2)")
    .action((workId: string, options: { json?: boolean; render?: boolean }) => {
      const location = requireProject(process.cwd());
      refusing(() => {
        const item = requireDecidableItem(location, workId); // lint writes needs-human.json, so it takes the write guard
        const now = new Date();
        if (options.render) refreshProjection(location, item, now);
        const report = reportOf(location, item, now);
        syncNeedsHuman(item.dir, scopeOf(item), report.gate, now);
        printReport(shownReport(report, item), options.json === true);
        if (report.gate.status === "blocked_on_user")
          console.error(`blocked on a person (J2); wrote ${needsHumanFile(item.dir)}`);
        process.exitCode = lintExitCode(report);
      });
    });

  decide
    .command("show")
    .argument("<work_id>")
    .option("--json", "print the report as JSON")
    .description(
      "print the decisions by status, the GATE-1 verdict and whether spec.md matches the ledger; writes nothing",
    )
    .action((workId: string, options: { json?: boolean }) => {
      const location = requireProject(process.cwd());
      refusing(() => {
        const item = loadConsistentItem(location, workId);
        printReport(shownReport(reportOf(location, item, new Date()), item), options.json === true);
      });
    });
}
