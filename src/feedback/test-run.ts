import { budgetStateFromEvents } from "../core/budget.js";
import type { Ledger, LedgerEvent } from "../core/ledger.js";
import { feedbackEvent, feedbackEventsOf } from "./events.js";
import { FeedbackError } from "./types.js";
import type { NoiseCheck } from "./noise.js";

/**
 * The sealed test split runs once per work item and test digest (spec §5.5 to §5.8). The only state is the
 * `feedback.test_*` events of the ledger, folded on every call, so a restart or a second process sees the same facts.
 * Counts and digests only: nothing here can carry a scenario id or text.
 */

export interface TestResult {
  pass: number;
  total: number;
  flaky: number;
}

export interface TestRunRecord {
  test_digest: string;
  run_id: string;
  candidate_sha: string;
  consumed_seq: number;
  status: "consumed_incomplete" | "completed";
  result: TestResult | null;
}

export interface TestRunState {
  /** In consumption order. */
  runs: TestRunRecord[];
  /** The latest authorization that no fresh consumption has spent yet. A null digest (J3 before any run) never lets a run start. */
  pending_authorization: { consumed_test_digest: string | null; basis: "J3" | "J6"; seq: number } | null;
}

function bad(seq: number, why: string): FeedbackError {
  return new FeedbackError("invalid_event", `invalid test-split event at seq ${seq}: ${why}`);
}

interface Fold {
  state: TestRunState;
  /** test_total of each consumed digest; the completion has to match it. */
  totals: Map<string, number>;
}

function foldTestRuns(events: readonly LedgerEvent[], goalId: string, workId: string): Fold {
  const runs: TestRunRecord[] = [];
  const totals = new Map<string, number>();
  let pending: TestRunState["pending_authorization"] = null;
  for (const item of feedbackEventsOf(events, goalId)) {
    const { event, seq } = item;
    if (event.payload.work_id !== workId) continue;
    switch (event.type) {
      case "feedback.test_run_consumed": {
        const p = event.payload;
        const latest = runs.at(-1);
        if (runs.some((r) => r.test_digest === p.test_digest)) throw bad(seq, "digest consumed twice");
        if (latest !== undefined && (pending === null || pending.consumed_test_digest !== latest.test_digest)) {
          throw bad(seq, "a fresh digest needs an authorization naming the latest consumed one");
        }
        pending = null;
        totals.set(p.test_digest, p.test_total);
        runs.push({
          test_digest: p.test_digest,
          run_id: p.run_id,
          candidate_sha: p.candidate_sha,
          consumed_seq: seq,
          status: "consumed_incomplete",
          result: null,
        });
        break;
      }
      case "feedback.test_run_completed": {
        const p = event.payload;
        const run = runs.find(
          (r) => r.test_digest === p.test_digest && r.run_id === p.run_id && r.candidate_sha === p.candidate_sha,
        );
        if (run === undefined || run.status !== "consumed_incomplete")
          throw bad(seq, "completion without an open consumption");
        if (p.total !== totals.get(p.test_digest)) throw bad(seq, "total differs from the consumed total");
        if (p.pass > p.total || p.flaky > p.total - p.pass) throw bad(seq, "counts out of range");
        run.status = "completed";
        run.result = { pass: p.pass, total: p.total, flaky: p.flaky };
        break;
      }
      case "feedback.test_reseal_authorized": {
        const p = event.payload;
        if (!item.actor.startsWith("human:")) throw bad(seq, "authorization by a non-person");
        const latest = runs.at(-1);
        if (p.consumed_test_digest === null) {
          // J3 with no run yet: it only restarts the exposure count, and only J3 can say that.
          if (latest !== undefined || p.basis !== "J3") throw bad(seq, "a null authorization is J3 before any run");
        } else if (latest === undefined || p.consumed_test_digest !== latest.test_digest || pending !== null) {
          throw bad(seq, "authorization must name the latest consumed digest, once");
        }
        pending = { consumed_test_digest: p.consumed_test_digest, basis: p.basis, seq };
        break;
      }
      default:
        break;
    }
  }
  return { state: { runs, pending_authorization: pending }, totals };
}

/**
 * Folds the test-split events of one work item. A sequence the writers never produce stops the line with
 * FeedbackError("invalid_event"): skipping it would silently reopen a consumed split.
 */
export function testRunStateFromEvents(events: readonly LedgerEvent[], goalId: string, workId: string): TestRunState {
  return foldTestRuns(events, goalId, workId).state;
}

export type TestRunPlan =
  | { action: "run" }
  | { action: "use_recorded"; result: TestResult }
  | { action: "blocked"; reason: "test_run_incomplete" }
  | { action: "needs_reseal" };

/**
 * What the run may do with this test digest. A recorded result is reusable only for the commit it was measured on:
 * M3b1 lets a killed run restart from S1 with changed code, and attaching the old commit's result to new code would
 * fail open toward `merge_recommended`. `candidateSha` null (unknown) never matches, so it fails closed.
 */
export function planTestRun(state: TestRunState, testDigest: string, candidateSha: string | null): TestRunPlan {
  const own = state.runs.find((r) => r.test_digest === testDigest);
  if (own !== undefined) {
    if (own.status === "consumed_incomplete" || own.result === null)
      return { action: "blocked", reason: "test_run_incomplete" };
    if (candidateSha !== null && own.candidate_sha === candidateSha)
      return { action: "use_recorded", result: own.result };
    return { action: "needs_reseal" };
  }
  const latest = state.runs.at(-1);
  if (latest === undefined) return { action: "run" };
  const pending = state.pending_authorization;
  if (pending !== null && pending.consumed_test_digest === latest.test_digest) return { action: "run" };
  return { action: "needs_reseal" };
}

/**
 * Input for the M3b2 classifier. Both are `blocked`, not `manual`: a manual park refuses re-entry until a later
 * milestone adds its clearing event, which would strand the item after the person has acted.
 */
export function testRunBlock(
  plan: TestRunPlan,
): { outcome: "blocked"; reason_code: "test_run_incomplete" | "test_reseal_required" } | null {
  if (plan.action === "blocked") return { outcome: "blocked", reason_code: "test_run_incomplete" };
  if (plan.action === "needs_reseal") return { outcome: "blocked", reason_code: "test_reseal_required" };
  return null;
}

/** Evidence `sealed.test`. A consumed digest is never "not yet run", and another commit's result is not a result for this code. */
export type SealedTestField = TestResult | "not yet run" | "consumed_incomplete" | "consumed_other_candidate";

export function sealedTestField(state: TestRunState, testDigest: string, candidateSha: string | null): SealedTestField {
  const own = state.runs.find((r) => r.test_digest === testDigest);
  if (own === undefined) return "not yet run";
  if (own.status === "consumed_incomplete" || own.result === null) return "consumed_incomplete";
  return candidateSha !== null && own.candidate_sha === candidateSha ? own.result : "consumed_other_candidate";
}

export type FeedbackEntryCheck =
  | { status: "proceed" }
  | { status: "not_declared" }
  | { status: "blocked"; reason_code: "test_run_incomplete" | "test_reseal_required" };

/**
 * Run-entry precheck for the line to call after the seal stands and before the round opens; no caller is wired yet. `blocked` items re-enter on every run, and none of
 * these states clears without a person, so finding them only at the late station would repeat S1 to S4 (model spend, train
 * rounds, disclosure units) on every re-entry. It is the same planTestRun plus testRunBlock the test station uses, so the
 * two cannot disagree. Budget first: with no declared disclosure budget the line stops whatever the test split says.
 */
export function feedbackEntryCheck(
  events: readonly LedgerEvent[],
  goalId: string,
  workId: string,
  testDigest: string,
  candidateSha: string | null,
): FeedbackEntryCheck {
  if (budgetStateFromEvents(events, goalId, "disclosure") === null) return { status: "not_declared" };
  const block = testRunBlock(planTestRun(testRunStateFromEvents(events, goalId, workId), testDigest, candidateSha));
  return block === null ? { status: "proceed" } : { status: "blocked", reason_code: block.reason_code };
}

/**
 * Consumes the test split BEFORE it runs, so a crash leaves "consumed, incomplete" and never "not yet run". The fold, the
 * plan and the write share one ledger lock, so two processes cannot both consume. Error messages are fixed text: no caller
 * string reaches them.
 */
export function beginTestRun(
  ledger: Ledger,
  input: { goalId: string; workId: string; runId: string; testDigest: string; candidateSha: string; testTotal: number },
): LedgerEvent {
  if (!Number.isInteger(input.testTotal) || input.testTotal < 1) {
    throw new FeedbackError("invalid_input", "testTotal must be an integer of at least 1");
  }
  return ledger.appendWith((events) => {
    const { state } = foldTestRuns(events, input.goalId, input.workId);
    if (state.runs.some((r) => r.test_digest === input.testDigest)) {
      throw new FeedbackError("test_already_consumed", "this test split was already consumed for the work item");
    }
    if (planTestRun(state, input.testDigest, input.candidateSha).action !== "run") {
      throw new FeedbackError("reseal_not_authorized", "a fresh test split needs a person's authorization");
    }
    return feedbackEvent(
      {
        type: "feedback.test_run_consumed",
        payload: {
          goal_id: input.goalId,
          work_id: input.workId,
          run_id: input.runId,
          test_digest: input.testDigest,
          candidate_sha: input.candidateSha,
          test_total: input.testTotal,
        },
      },
      "omf",
    );
  });
}

/** Records the result of an open consumption (same digest, run id and commit). The counts are checked here and again by the fold. */
export function completeTestRun(
  ledger: Ledger,
  input: { goalId: string; workId: string; runId: string; testDigest: string; candidateSha: string } & TestResult,
): LedgerEvent {
  return ledger.appendWith((events) => {
    const { state, totals } = foldTestRuns(events, input.goalId, input.workId);
    const open = state.runs.find(
      (r) =>
        r.status === "consumed_incomplete" &&
        r.test_digest === input.testDigest &&
        r.run_id === input.runId &&
        r.candidate_sha === input.candidateSha,
    );
    if (open === undefined)
      throw new FeedbackError("no_open_test_run", "no open test-split consumption matches this run");
    const { pass, total, flaky } = input;
    const whole = [pass, total, flaky].every((n) => Number.isInteger(n) && n >= 0);
    if (!whole || total !== totals.get(input.testDigest) || pass > total || flaky > total - pass) {
      throw new FeedbackError(
        "invalid_input",
        "the counts must be whole, match the consumed total and fit pass + flaky <= total",
      );
    }
    return feedbackEvent(
      {
        type: "feedback.test_run_completed",
        payload: {
          goal_id: input.goalId,
          work_id: input.workId,
          run_id: input.runId,
          test_digest: input.testDigest,
          candidate_sha: input.candidateSha,
          pass,
          total,
          flaky,
        },
      },
      "omf",
    );
  });
}

/**
 * The human act (J3 or J6) that lets ONE fresh test digest run after a consumed one. It names the latest consumed digest and
 * never reopens it. With no run consumed yet only J3 is allowed: it names no digest and only restarts the exposure count for
 * fresh scenarios. The M3h verb wraps this in requireTerminal and confirmByTyping; until then the actor check is the guard.
 */
export function authorizeTestReseal(
  ledger: Ledger,
  input: { goalId: string; workId: string; basis: "J3" | "J6" },
  actor: string,
): LedgerEvent {
  if (!actor.startsWith("human:")) throw new FeedbackError("forbidden", "only a person may authorize a test reseal");
  return ledger.appendWith((events) => {
    const { state } = foldTestRuns(events, input.goalId, input.workId);
    const latest = state.runs.at(-1);
    if (latest === undefined) {
      if (input.basis === "J6")
        throw new FeedbackError("nothing_to_reseal", "no test split was consumed yet; only J3 applies");
    } else if (state.pending_authorization !== null) {
      throw new FeedbackError("already_authorized", "a reseal is already authorized and unused");
    }
    return feedbackEvent(
      {
        type: "feedback.test_reseal_authorized",
        payload: {
          goal_id: input.goalId,
          work_id: input.workId,
          consumed_test_digest: latest === undefined ? null : latest.test_digest,
          basis: input.basis,
        },
      },
      actor,
    );
  });
}

/**
 * What M3b2's evidence calls `sealed.test`: { pass, total } or the word "not run", never anything else.
 * `consumed_incomplete` and `consumed_other_candidate` are real states on the host (the handoff and the
 * `blocked` outcomes use them), but they are not a result for this code, so the evidence reads them as not run.
 * A total of 0 is not a pass either (E7). `flaky` is dropped here and nothing else carries test-split flakiness into the classifier: it reads
 * flaky counts of the train split only. Known gap until the station that builds the evidence passes the test-split flakiness on.
 */
export function evidenceSealedTest(field: SealedTestField): { pass: number; total: number } | "not run" {
  if (typeof field === "string") return "not run";
  if (field.total === 0) return "not run";
  return { pass: field.pass, total: field.total };
}

/**
 * What the evidence calls `noise_check`: `ok | within_variance | not_evaluated | not run`. v0.1 never evaluates variance, so
 * every computed check is `not_evaluated`, k < 2 included (kept fail closed: the evidence lists it as an unverified area); no
 * check yet is `not run`. The classifier reads no noise reason code. It sees flakiness only through the train counts of `sealed.train`;
 * flakiness of the test split reaches it by no path today (known gap).
 */
export function noiseCheckField(check: NoiseCheck | null): "not_evaluated" | "not run" {
  return check === null ? "not run" : "not_evaluated";
}
