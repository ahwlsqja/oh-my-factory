import type { Ledger, LedgerEvent } from "../core/ledger.js";
import { parseDuration } from "./duration.js";
import { type GoalApproval, type GoalLock, latestApproval } from "./goal-lock.js";

/**
 * J8 (spec §4.4): raising the wall time cap is a person's decision. Re-approval still refuses to change
 * the wall time in goal.md, so this event is the only way to extend it. The goal must be approved, because
 * a raise counts from the approval it follows.
 */
export function raiseWallTime(ledger: Ledger, goalId: string, by: string, actor: string): void {
  if (!actor.startsWith("human:")) throw new Error(`only a person raises wall time (J8); actor was ${actor}`);
  parseDuration(by);
  ledger.appendWith((events) => {
    if (latestApproval(events, goalId) === null)
      throw new Error(`goal ${goalId} is not approved; there is no wall time to raise`);
    return { actor, type: "goal.wall_time_raised", payload: { goal_id: goalId, by } };
  });
}

function invalidRaise(event: LedgerEvent, why: string): Error {
  return new Error(`invalid goal.wall_time_raised event at seq ${event.seq}: ${why}`);
}

/**
 * The wall time limit in milliseconds: the approved wall time plus every raise since the latest approval
 * (D26). The approved value comes from the ledger (`goal.approved.wall_time`); the goal lock is only the
 * fallback for an approval from before M2b, so deleting the lock file cannot lengthen or shorten it.
 * A raise before a re-approval does not carry over: a re-approval is a new J1 decision about the whole
 * goal, and the person raises again if the extension is still wanted. The clock still starts at the first
 * approval (see `GoalApproval.first_approved_at`).
 */
export function wallTimeLimitMs(
  events: readonly LedgerEvent[],
  goalId: string,
  approval: GoalApproval,
  lock: GoalLock | null,
): number {
  const base = approval.wall_time ?? lock?.semantic.budget.wall_time;
  if (base === undefined)
    throw new Error(`the approved wall time of goal ${goalId} is not recorded; approve the goal again`);
  let raised = 0;
  for (const event of events) {
    if (event.payload.goal_id !== goalId) continue;
    if (event.type === "goal.approved") {
      raised = 0;
    } else if (event.type === "goal.wall_time_raised") {
      if (!event.actor.startsWith("human:")) throw invalidRaise(event, `raised by ${event.actor}`);
      const { by } = event.payload;
      if (typeof by !== "string") throw invalidRaise(event, "malformed by");
      try {
        raised += parseDuration(by);
      } catch {
        throw invalidRaise(event, "malformed by");
      }
    }
  }
  return parseDuration(base) + raised;
}
