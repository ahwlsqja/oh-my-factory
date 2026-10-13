import type { REFRESH } from "../core/config.js";
import { parseDuration } from "./duration.js";
import type { Operator } from "./goal-file.js";
import type { GoalApproval } from "./goal-lock.js";

/** The raw numbers behind a verdict. They go to the host-only ledger and tick report, never to a reconciler (spec §4.6). */
export interface StaleSignals {
  /** Time since the latest J1 approval. */
  age_ms: number;
  /** First-parent commits since the approval commit; null when that commit is gone. */
  commits_since: number | null;
  /** Worsening of the target metric relative to its first in-regime value; null when it does not apply. */
  target_move: number | null;
}

export interface StaleVerdict {
  stale: boolean;
  /** In the fixed order age, commits, target_move. */
  tripped: ("age" | "commits" | "target_move")[];
  signals: StaleSignals;
}

/**
 * How far the target metric has moved away from the locked target since the first measurement of the
 * regime. Improvement is never a reason to re-interview a person, so only worsening counts:
 * `<=` worsens when the value rises, `>=` when it falls, and `==` cannot tell (the target value is not
 * an input), so any movement while the target is unmet counts. The move is relative to |first|; when
 * the first value is 0 there is nothing to be relative to, so the absolute delta is used instead.
 * Null while the latest measurement meets the target, when the verdict is pending (`targetMet` null),
 * or when either value is missing.
 */
function targetMoveOf(args: {
  targetFirst: number | null;
  targetLatest: number | null;
  targetOperator: Operator;
  targetMet: boolean | null;
}): number | null {
  const { targetFirst: first, targetLatest: latest, targetOperator: operator, targetMet } = args;
  if (first === null || latest === null || targetMet === null || targetMet) return null;
  const worse = operator === "<=" ? latest - first : operator === ">=" ? first - latest : Math.abs(latest - first);
  if (worse <= 0) return 0;
  return first === 0 ? worse : worse / Math.abs(first);
}

/**
 * Staleness of an approved goal (spec §4.4 step 6): too old, too many commits since approval, or the
 * target metric moving away from the target. Pure: the caller supplies the clock, the commit count and
 * the two target values, so the verdict is repeatable. Every limit is exclusive: a value equal to the
 * `REFRESH` threshold is not stale. A vanished approval commit (`commitsSince` null) counts as tripped
 * commits, because nothing can be said about what changed since.
 */
export function evaluateStaleness(args: {
  approval: GoalApproval;
  config: typeof REFRESH;
  now: Date;
  commitsSince: number | null;
  targetFirst: number | null;
  targetLatest: number | null;
  targetOperator: Operator;
  targetMet: boolean | null;
}): StaleVerdict {
  const { approval, config, now, commitsSince } = args;
  const signals: StaleSignals = {
    age_ms: now.getTime() - Date.parse(approval.approved_at),
    commits_since: commitsSince,
    target_move: targetMoveOf(args),
  };
  const tripped: StaleVerdict["tripped"] = [];
  if (signals.age_ms > parseDuration(config.max_age)) tripped.push("age");
  if (commitsSince === null || commitsSince > config.max_commits) tripped.push("commits");
  if (signals.target_move !== null && signals.target_move > config.max_target_move) tripped.push("target_move");
  return { stale: tripped.length > 0, tripped, signals };
}
