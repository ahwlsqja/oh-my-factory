import type { DecisionClass } from "../decision/types.js";
import { FeedbackError, type CategoryTally, type ReleasedCategory } from "./types.js";

function requireCount(value: number, what: string): void {
  if (!Number.isInteger(value)) throw new FeedbackError("invalid_input", `${what} must be an integer`);
}

/**
 * floor(100 * pass / total), for rendering and the evidence only: no decision uses it. The arithmetic stays in
 * exact integers, so a quotient just below a whole percent can never round up.
 */
export function scorePct(pass: number, total: number): number {
  requireCount(pass, "pass");
  requireCount(total, "total");
  if (total < 1) throw new FeedbackError("invalid_input", "total must be at least 1");
  if (pass < 0 || pass > total) throw new FeedbackError("invalid_input", "pass must be between 0 and total");
  const scaled = 100 * pass;
  return (scaled - (scaled % total)) / total;
}

/**
 * Spec §5.7: a new score is shown only when it gains at least max(0.1, 1/sqrt(n)) over the best released one. With d the
 * gain in passed scenarios and n the scenario count, d/n >= 0.1 is 10*d >= n and d/n >= 1/sqrt(n) is d*d >= n. Both hold
 * in exact integers, so there is no float and no sqrt, and floored percents cannot inflate a gain by almost a point
 * (n=110, d=10 is 9.09%: false). d <= 0 is never a gain.
 */
export function meetsMargin(d: number, n: number): boolean {
  requireCount(d, "gain");
  requireCount(n, "n");
  if (n < 1) throw new FeedbackError("invalid_input", "n must be at least 1");
  if (d <= 0) return false;
  return 10 * d >= n && d * d >= n;
}

export interface BestEntry {
  pass: number;
  n: number;
}
export type LadderBest = ReadonlyMap<DecisionClass, BestEntry>;

/**
 * One decision per merged category, in input order (spec §5.7). No best yet: release the actual score as `first`.
 * A gain that meets the margin: release it as `new`. Anything else, including a lower score, repeats the best released
 * pass count, so the implementer never sees a decrease and learns nothing from noise below the margin. Every entry carries
 * `pass`, which only the host ledger keeps (the renderer prints the percent and n), so the fold can re-check the ladder
 * exactly. A best taken over a different n is refused: ratios over different scenario sets are not comparable.
 */
export function decideRelease(best: LadderBest, merged: readonly CategoryTally[]): ReleasedCategory[] {
  return merged.map((actual): ReleasedCategory => {
    const n = actual.total;
    const previous = best.get(actual.category);
    if (previous === undefined) {
      return { category: actual.category, n, pass: actual.pass, score_pct: scorePct(actual.pass, n), kind: "first" };
    }
    if (previous.n !== n)
      throw new FeedbackError("invalid_input", "the best released score covers a different scenario count");
    if (meetsMargin(actual.pass - previous.pass, n)) {
      return { category: actual.category, n, pass: actual.pass, score_pct: scorePct(actual.pass, n), kind: "new" };
    }
    return { category: actual.category, n, pass: previous.pass, score_pct: scorePct(previous.pass, n), kind: "repeat" };
  });
}
