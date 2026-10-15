import { budgetConsumedEvent, budgetStateFromEvents } from "../core/budget.js";
import type { Ledger } from "../core/ledger.js";
import { RUN_ID_PATTERN } from "../work/w-events.js";
import { type LadderState, exposureUnitsOf, feedbackEvent, ladderStateFromEvents } from "./events.js";
import { decideRelease } from "./ladder.js";
import { isAllowlistedFeedback, renderFeedback } from "./render.js";
import { mergeSmallCategories, parseScenarioResults, tallyResults } from "./tally.js";
import {
  type CategoryTally,
  EXPOSURE_LIMIT_DEFAULT,
  FeedbackError,
  MIN_CATEGORY_SIZE,
  type ReleasedCategory,
  type ScenarioResult,
} from "./types.js";

/**
 * Masked feedback is the one channel from the sealed train scenarios to the implementer (spec §5.7, §4.6), so one
 * function owns it: it validates, folds the ladder and the budget from the ledger it holds locked, and writes the
 * disclosure unit together with the release record.
 */

// The same patterns as the id definitions of work-event.schema.json (tests pin the equality through the feedback events).
const GOAL_ID_PATTERN = /^g-[a-z0-9]+(-[a-z0-9]+)*$/;
const WORK_ID_PATTERN = /^w-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface ReleaseInput {
  goalId: string;
  workId: string;
  runId: string;
  /** sha256 hex of the train split of the current set (supplied by the vault, M3c). */
  trainDigest: string;
  /** Re-parsed with parseScenarioResults before use: a scenario object with an id or text in it is refused. */
  results: readonly ScenarioResult[];
  /** Integer 1..EXPOSURE_LIMIT_DEFAULT (spec 437); default EXPOSURE_LIMIT_DEFAULT. Anything else is invalid_input. */
  exposureLimit?: number;
}

declare const implementerFeedbackBrand: unique symbol;
/**
 * The ONLY value the delivery path (M3h) may accept. It carries the text and nothing else, so whether a score is new or a
 * repeat cannot be forwarded by accident; `host_only` below is for the host and the evidence.
 */
export interface ImplementerFeedback {
  readonly [implementerFeedbackBrand]: true;
  readonly text: string;
}

export type WithheldReason = "disclosure_exhausted" | "exposure_limit" | "too_few_scenarios";
export type ReleaseResult =
  | {
      status: "released";
      feedback: ImplementerFeedback;
      host_only: { round: number; categories: ReleasedCategory[]; disclosure_units: 0 | 1 };
    }
  | { status: "withheld"; reason: WithheldReason };

/** Thrown out of the locked callback so nothing is written; releaseFeedback turns it into a `withheld` result. */
class Withheld extends Error {
  constructor(readonly reason: WithheldReason) {
    super(`feedback withheld: ${reason}`);
  }
}

/** Messages are fixed text: a caller-supplied id or digest is never echoed into an error. */
function requireWellFormed(input: ReleaseInput): number {
  if (typeof input.goalId !== "string" || input.goalId.length > 80 || !GOAL_ID_PATTERN.test(input.goalId)) {
    throw new FeedbackError("invalid_input", "goalId is not well formed");
  }
  if (typeof input.workId !== "string" || !WORK_ID_PATTERN.test(input.workId)) {
    throw new FeedbackError("invalid_input", "workId is not well formed");
  }
  if (typeof input.runId !== "string" || !RUN_ID_PATTERN.test(input.runId)) {
    throw new FeedbackError("invalid_input", "runId is not well formed");
  }
  if (typeof input.trainDigest !== "string" || !DIGEST_PATTERN.test(input.trainDigest)) {
    throw new FeedbackError("invalid_input", "trainDigest is not a sha256 hex digest");
  }
  const limit: unknown = input.exposureLimit ?? EXPOSURE_LIMIT_DEFAULT;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > EXPOSURE_LIMIT_DEFAULT) {
    throw new FeedbackError("invalid_input", `exposureLimit must be an integer from 1 to ${EXPOSURE_LIMIT_DEFAULT}`);
  }
  return limit;
}

/** The digest does not pin the layout, so a release must match the layout already recorded under it. */
function sameLayout(layout: NonNullable<LadderState["layout"]>, workId: string, merged: readonly CategoryTally[]): boolean {
  return (
    layout.work_id === workId &&
    layout.categories.length === merged.length &&
    layout.categories.every((c, i) => c.category === merged[i]?.category && c.n === merged[i]?.total)
  );
}

/**
 * 0. Validate everything before the ledger is touched: a malformed call can never spend a unit. An empty train split is
 *    an error (zero is never a pass, E7); under MIN_CATEGORY_SIZE scenarios in total nothing is released, because a
 *    category below 5 would be a per-scenario verdict (spec §5.7), and nothing is consumed or appended.
 * 1. One `appendWithMany`, decided from the events seen under the lock: a declared `disclosure` budget is required even
 *    for a repeat; the layout must match; a release that shows any new score costs one unit and counts toward
 *    the exposure limit; a pure repeat is free. The unit and the release are one write; a crash mid-write can at
 *    worst leave the unit without its release (a unit lost, never a release unpaid).
 * BudgetError(`invalid_event`) and LedgerCorruptError propagate unwrapped; callers must handle them as integrity stops.
 * The caller holds the item claim; the lock makes the decision atomic even without it.
 */
export function releaseFeedback(ledger: Ledger, input: ReleaseInput): ReleaseResult {
  const limit = requireWellFormed(input);
  const results = parseScenarioResults(input.results);
  if (results.length === 0) throw new FeedbackError("no_train_scenarios", "the train split has no scenarios; zero is never a pass");
  if (results.length < MIN_CATEGORY_SIZE) return { status: "withheld", reason: "too_few_scenarios" };
  const merged = mergeSmallCategories(tallyResults(results));

  const outcome: { round?: number; categories?: ReleasedCategory[]; units?: 0 | 1; text?: string } = {};
  try {
    ledger.appendWithMany((events) => {
      const budget = budgetStateFromEvents(events, input.goalId, "disclosure");
      if (budget === null) {
        throw new FeedbackError("not_declared", "no disclosure budget is declared for this goal; a person declares one (J8)");
      }
      const ladder = ladderStateFromEvents(events, input.goalId, input.trainDigest);
      if (ladder.layout !== null && !sameLayout(ladder.layout, input.workId, merged)) {
        throw new FeedbackError("invalid_input", "the train set layout differs from the one already released under this digest");
      }
      const categories = decideRelease(ladder.best, merged);
      const units: 0 | 1 = categories.every((c) => c.kind === "repeat") ? 0 : 1;
      const round = ladder.releases + 1;
      // Built and schema-checked before anything is returned for writing, so a bad record cannot leave a unit behind.
      const released = feedbackEvent(
        {
          type: "feedback.released",
          payload: {
            goal_id: input.goalId,
            work_id: input.workId,
            run_id: input.runId,
            train_digest: input.trainDigest,
            round,
            categories,
            disclosure_units: units,
          },
        },
        "omf",
      );
      const text = renderFeedback(categories);
      if (!isAllowlistedFeedback(text)) throw new FeedbackError("invalid_input", "rendered feedback is outside the allowlist");
      Object.assign(outcome, { round, categories, units, text });
      if (units === 0) return [released];
      if (exposureUnitsOf(events, input.goalId, input.workId) >= limit) throw new Withheld("exposure_limit");
      if (budget.remaining < 1) throw new Withheld("disclosure_exhausted");
      return [budgetConsumedEvent(input.goalId, "disclosure", 1), released];
    });
  } catch (error) {
    if (error instanceof Withheld) return { status: "withheld", reason: error.reason };
    throw error;
  }
  if (outcome.round === undefined || outcome.categories === undefined || outcome.units === undefined || outcome.text === undefined) {
    throw new Error("unreachable: the release was not computed");
  }
  return {
    status: "released",
    feedback: { text: outcome.text } as ImplementerFeedback,
    host_only: { round: outcome.round, categories: outcome.categories, disclosure_units: outcome.units },
  };
}
