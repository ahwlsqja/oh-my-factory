import { DECISION_CLASSES } from "../decision/types.js";
import { FeedbackError } from "./types.js";
import type { ReleasedCategory } from "./types.js";

/**
 * The implementer-facing feedback text (spec §5.7, §5.8). A fixed template over validated enums and integers:
 * the only variable parts are a class name from DECISION_CLASSES, a whole percent and a scenario count. A new kind of
 * line needs an edit to the patterns below and to the E2-W-b test, so the allowlist cannot grow by accident.
 */
const HEADER = "Masked feedback from the train scenarios.";
const FOOTER = "No other information about the scenarios is available.";

/** Upper bound of n the template accepts; keeps the digit run in a line short (7 digits) and the pattern exact. */
const MAX_RENDERED_N = 9_999_999;

/** Built from DECISION_CLASSES, never `[a-z_]+`: an unknown class name cannot pass the allowlist. */
const CATEGORY_LINE = new RegExp(
  `^- (${DECISION_CLASSES.join("|")}): (100|[1-9]?[0-9])% of ([1-9][0-9]{0,6}) scenarios$`,
);

const isIntIn = (value: unknown, low: number, high: number): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= low && value <= high;

/**
 * Throws FeedbackError("invalid_input") for an empty list, a repeated or unknown category, a percent outside 0..100 or
 * an n outside 1..9999999. Messages hold the entry index only, never the offending value: a caller that passed
 * something it should not have must not see it echoed into a log.
 */
export function renderFeedback(categories: readonly ReleasedCategory[]): string {
  if (categories.length === 0) {
    throw new FeedbackError("invalid_input", "renderFeedback: no categories to render");
  }
  const classNames: readonly string[] = DECISION_CLASSES;
  const rows: { order: number; line: string }[] = [];
  const seen = new Set<number>();
  categories.forEach((entry, index) => {
    const order = classNames.indexOf(entry.category);
    if (order < 0) throw new FeedbackError("invalid_input", `renderFeedback: category ${index} is not a known class`);
    if (seen.has(order)) throw new FeedbackError("invalid_input", `renderFeedback: category ${index} is repeated`);
    if (!isIntIn(entry.score_pct, 0, 100)) {
      throw new FeedbackError("invalid_input", `renderFeedback: category ${index} has a percent outside 0..100`);
    }
    if (!isIntIn(entry.n, 1, MAX_RENDERED_N)) {
      throw new FeedbackError(
        "invalid_input",
        `renderFeedback: category ${index} has a scenario count outside 1..${MAX_RENDERED_N}`,
      );
    }
    seen.add(order);
    rows.push({ order, line: `- ${entry.category}: ${entry.score_pct}% of ${entry.n} scenarios` });
  });
  rows.sort((a, b) => a.order - b.order);
  return [HEADER, ...rows.map((row) => row.line), FOOTER].join("\n");
}

/**
 * True iff the text is exactly the header, one or more category lines, and the footer, joined by "\n" with no trailing
 * newline. Used by releaseFeedback as a self-check and by the tests; it accepts nothing renderFeedback cannot produce
 * except an unsorted or repeated category, which the renderer itself refuses: the order and uniqueness of categories are
 * not checked here.
 */
export function isAllowlistedFeedback(text: string): boolean {
  if (typeof text !== "string") return false;
  const lines = text.split("\n");
  if (lines.length < 3) return false;
  if (lines[0] !== HEADER || lines[lines.length - 1] !== FOOTER) return false;
  return lines.slice(1, -1).every((line) => CATEGORY_LINE.test(line));
}
