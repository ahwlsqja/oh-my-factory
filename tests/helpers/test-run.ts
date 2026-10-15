import { Ledger, type LedgerEvent } from "../../src/core/ledger.js";
import { type TestRunState, testRunStateFromEvents } from "../../src/feedback/test-run.js";
import { FeedbackError } from "../../src/feedback/types.js";
import { makeTempDir } from "./tmp.js";

/** Fixed ids for the test-split tests: one goal, one item, two runs, three test digests, two candidate commits. */
export const GOAL = "g-fast";
export const WORK = "w-0123456789ab";
export const RUN_1 = "r-20261014T091500Z-ab12";
export const RUN_2 = "r-20261014T091600Z-cd34";
export const DIGEST_A = "a".repeat(64);
export const DIGEST_B = "b".repeat(64);
export const DIGEST_C = "c".repeat(64);
export const SHA_1 = "1".repeat(40);
export const SHA_2 = "2".repeat(40);
export const scope = { goal_id: GOAL, work_id: WORK };

export const newLedger = (): Ledger => new Ledger(makeTempDir("omf-test-run-"));

/**
 * Appends an event exactly as given, bypassing every writer: the tests use it to forge sequences the writers refuse,
 * because the fold must reject them on its own.
 */
export function raw(ledger: Ledger, type: string, payload: Record<string, unknown>, actor = "omf"): LedgerEvent {
  return ledger.append({ actor, type, payload });
}

export const consume = (ledger: Ledger, digest: string, sha = SHA_1, run = RUN_1, total = 10): LedgerEvent =>
  raw(ledger, "feedback.test_run_consumed", {
    ...scope,
    run_id: run,
    test_digest: digest,
    candidate_sha: sha,
    test_total: total,
  });

export const complete = (
  ledger: Ledger,
  digest: string,
  sha = SHA_1,
  run = RUN_1,
  counts = { pass: 8, total: 10, flaky: 1 },
): LedgerEvent =>
  raw(ledger, "feedback.test_run_completed", {
    ...scope,
    run_id: run,
    test_digest: digest,
    candidate_sha: sha,
    ...counts,
  });

/** A person's authorization; `digest` null is the J3 act that names no consumed run. */
export const authorize = (
  ledger: Ledger,
  digest: string | null,
  basis: "J3" | "J6" = "J3",
  actor = "human:dev",
): LedgerEvent =>
  raw(ledger, "feedback.test_reseal_authorized", { ...scope, consumed_test_digest: digest, basis }, actor);

export const stateOf = (ledger: Ledger): TestRunState => testRunStateFromEvents(ledger.readVerified(), GOAL, WORK);

/** The FeedbackError code a call throws, `undefined` when it does not throw, "not a FeedbackError" for anything else. */
export function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof FeedbackError ? err.code : "not a FeedbackError";
  }
  return undefined;
}
