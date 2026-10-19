import type { LedgerEvent } from "../core/ledger.js";

const TRIPPED = new Set(["age", "commits", "target_move"]);

/**
 * The signals of the latest `goal.stale` event since the latest `goal.approved` of this goal, or null.
 * A new approval clears the mark, so re-approving a stale goal is the way out of the J1 stop.
 */
function markOf(events: readonly LedgerEvent[], goalId: string): string[] | null {
  let mark: string[] | null = null;
  for (const event of events) {
    if (event.payload.goal_id !== goalId) continue;
    if (event.type === "goal.approved") {
      mark = null;
    } else if (event.type === "goal.stale") {
      const { tripped } = event.payload;
      if (
        !Array.isArray(tripped) ||
        tripped.length === 0 ||
        !tripped.every((t) => typeof t === "string" && TRIPPED.has(t))
      ) {
        throw new Error(`invalid goal.stale event at seq ${event.seq}: malformed tripped`);
      }
      mark = tripped as string[];
    }
  }
  return mark;
}

/**
 * True when refresh (spec §4.4 step 6) judged the goal stale after its latest approval. Lives apart from
 * refresh.ts so that audit.ts can read it without importing the stage that writes it.
 */
export function isMarkedStale(events: readonly LedgerEvent[], goalId: string): boolean {
  return markOf(events, goalId) !== null;
}

/** The regime-change reason audit reports for a stale mark, for example `goal marked stale (age,commits)`, or null. */
export function staleReason(events: readonly LedgerEvent[], goalId: string): string | null {
  const mark = markOf(events, goalId);
  return mark === null ? null : `goal marked stale (${mark.join(",")})`;
}
