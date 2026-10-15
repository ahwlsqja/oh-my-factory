import type { DecisionClass } from "../decision/types.js";

/** Spec §5.7: a category with fewer scenarios than this is merged into the largest before release. */
export const MIN_CATEGORY_SIZE = 5;
/** Spec §5.5 `exposure.limit`. A caller may pass a smaller limit; the release function validates it as an integer 1..this value. */
export const EXPOSURE_LIMIT_DEFAULT = 20;

/**
 * The only thing the feedback code reads about a judged scenario (E2-W-b). No id, no text, no step: there is no field a
 * scenario's input, expected output or assertion could ride in. `passed` means every one of the k repetitions passed;
 * `flaky` means the k repetitions disagreed. flaky implies !passed.
 */
export interface ScenarioResult {
  category: DecisionClass;
  passed: boolean;
  flaky: boolean;
}

export interface CategoryTally {
  category: DecisionClass;
  pass: number;
  total: number;
  flaky: number;
}

export type ScoreKind = "first" | "new" | "repeat";

/**
 * One released line. score_pct is a whole percent 0..100 and n is the scenario count of the (merged) category. `pass` is the
 * released pass count (the best's count for a repeat); it lives only in the host ledger so the fold can re-check the ladder
 * exactly, and the renderer never prints it. score_pct = floor(100 * pass / n), for rendering only.
 */
export interface ReleasedCategory {
  category: DecisionClass;
  n: number;
  pass: number;
  score_pct: number;
  kind: ScoreKind;
}

export type FeedbackErrorCode =
  | "invalid_input"
  | "no_train_scenarios"
  | "not_declared"
  | "invalid_event"
  | "test_already_consumed"
  | "reseal_not_authorized"
  | "no_open_test_run"
  | "nothing_to_reseal"
  | "already_authorized"
  | "forbidden";

/** Messages are built from codes, indexes and counts only; never from caller-supplied strings. */
export class FeedbackError extends Error {
  constructor(
    readonly code: FeedbackErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FeedbackError";
  }
}
