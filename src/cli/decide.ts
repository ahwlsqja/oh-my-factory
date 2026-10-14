import { existsSync } from "node:fs";
import { findWorkItem } from "../adapters/state-markdown.js";
import { Ledger, type LedgerEvent } from "../core/ledger.js";
import type { ProjectLocation } from "../core/paths.js";
import { type Gate1Result, evaluateGate1, intentQuestionIds } from "../decision/gate1.js";
import { type LeakContext, loadLeakContext } from "../decision/leak-lint.js";
import { type DecisionLinks, type LintProblem, lintDecisions } from "../decision/lint.js";
import { needsHumanFile, syncNeedsHuman } from "../decision/needs-human.js";
import { renderSpec, specStatus, writeSpec } from "../decision/spec-md.js";
import { foldDecisions } from "../decision/state.js";
import type {
  AddInput,
  DecisionScope,
  DecisionState,
  DeferInput,
  NaInput,
  ResolveInput,
} from "../decision/types.js";
import {
  type WriteContext,
  addDecision,
  deferDecision,
  markNotApplicable,
  resolveDecision,
} from "../decision/write.js";
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
 * its claim. Nothing in M3a can produce `in_progress` (work.started is M3b1), so an `in_progress` item
 * here was hand-edited; and decisions must not change while a run holds the claim, or the run would
 * drift from the `spec.md` it was sealed with (M3a design A12). Plain errors: exit 2.
 */
export function requireDecidableItem(location: ProjectLocation, workId: string): WorkItem {
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
export function decideReport(location: ProjectLocation, workId: string, now: Date, links?: DecisionLinks): DecideReport {
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
