import type { Operator } from "./goal-file.js";

export type GapDirection = "decrease" | "increase" | "none";
export type GapSize = "none" | "small" | "medium" | "large";

export interface TargetResult {
  met: boolean;
  gap: number;
  direction: GapDirection;
  /** Gap divided by |target|; null when the target is zero. */
  relative: number | null;
  size: GapSize;
}

/** Below 10% of the target is small, below 50% medium, anything else large. */
function sizeOf(relative: number | null): GapSize {
  if (relative === null || relative >= 0.5) return "large";
  return relative < 0.1 ? "small" : "medium";
}

/** Gap to target (spec §4.4 step 3). Direction and size are what the goal loop passes down, never values. */
export function evaluateTarget(target: { operator: Operator; value: number }, measured: number): TargetResult {
  const { operator, value } = target;
  const met = operator === "<=" ? measured <= value : operator === ">=" ? measured >= value : measured === value;
  if (met) return { met: true, gap: 0, direction: "none", relative: 0, size: "none" };
  const gap = Math.abs(measured - value);
  const relative = value === 0 ? null : gap / Math.abs(value);
  return { met: false, gap, direction: measured > value ? "decrease" : "increase", relative, size: sizeOf(relative) };
}
