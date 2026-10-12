import type { ProjectLocation } from "../core/paths.js";
import { auditGoal } from "./audit.js";
import { ApprovalError, type ApprovalExpectation, type GoalApproval, lockGoal } from "./goal-lock.js";

export interface ApproveResult {
  approval: GoalApproval;
  /** False when the goal was already approved and nothing changed, so nothing was written. */
  created: boolean;
}

/**
 * J1 (spec §4.1). Locks a new regime when the goal is a draft, when it is `tampered` (a lock does not
 * verify; approving again repairs it), or when there is a regime change. An approved goal with nothing
 * changed is left alone, so approving twice writes nothing.
 */
export function approveGoal(
  location: ProjectLocation,
  goalId: string,
  actor: string,
  now: () => Date = () => new Date(),
  expected?: ApprovalExpectation,
): ApproveResult {
  if (!actor.startsWith("human:")) throw new ApprovalError(`only a person approves a goal (J1); actor was ${actor}`);
  const report = auditGoal(location, goalId, now());
  if (report.state === "invalid" || (report.state === "draft" && report.problems.length > 0)) {
    throw new ApprovalError(report.problems.join("; "));
  }
  if (report.state === "approved" && report.problems.length === 0 && report.approval !== null) {
    return { approval: report.approval, created: false };
  }
  return { approval: lockGoal(location, goalId, actor, now, expected), created: true };
}
