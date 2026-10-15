import type { LedgerEvent } from "../core/ledger.js";
import { classifyWEvent } from "./w-events.js";

/** How many items the count looks at. A window bounds both the value and what the reconciler can learn from it. */
export const RECENT_OUTCOME_WINDOW = 10;

/**
 * How recent work ended, as four counts (spec §4.6). These are the only keys, so no title, id, path, risk
 * or reason code of any item can ride in a number, and none of the keys names a metric.
 */
export interface RecentOutcomes {
  success: number;
  flawed: number;
  blocked: number;
  manual: number;
}

/**
 * Counts the last `window` items of one goal by how their last run ended. The ledger is the authority, so
 * this reads the verified W events and never an item file: per item the outcome of its last submitted, failed or
 * parked event (actor `omf`, schema-valid; a forged or malformed event is `classifyWEvent` kind none or invalid and
 * is skipped, so it neither counts nor takes an item out of the count).
 *
 * An item that is running again is not counted: a later `work.started`, `work.resumed` or `work.claim_reclaimed`
 * means the old outcome is stale. `work.started` is legal only from `ready`, so a parked in-progress item re-enters
 * with `work.resumed`; `lastStateEvent` ignores resumed, which is why this function looks at it itself.
 *
 * `workIds` is the set the caller trusts (verified items plus repairable ones). Items are ordered by the seq of
 * their last outcome event, newest first.
 */
export function recentOutcomes(
  events: readonly LedgerEvent[],
  goalId: string,
  workIds: ReadonlySet<string>,
  window: number = RECENT_OUTCOME_WINDOW,
): RecentOutcomes {
  if (!Number.isInteger(window) || window < 1) throw new RangeError("window must be a positive integer");
  const last = new Map<string, { seq: number; outcome: keyof RecentOutcomes } | null>();
  for (const event of events) {
    const classified = classifyWEvent(event);
    if (classified.kind !== "w") continue;
    const w = classified.event;
    if (w.payload.goal_id !== goalId || !workIds.has(w.payload.work_id)) continue;
    switch (w.type) {
      case "work.submitted":
      case "work.failed":
      case "work.parked":
        last.set(w.payload.work_id, { seq: classified.seq, outcome: w.payload.outcome });
        break;
      case "work.started":
      case "work.resumed":
      case "work.claim_reclaimed":
        last.set(w.payload.work_id, null);
        break;
      case "work.repaired":
        break;
      default: {
        const unreachable: never = w;
        return unreachable;
      }
    }
  }
  const counts: RecentOutcomes = { success: 0, flawed: 0, blocked: 0, manual: 0 };
  const ended = [...last.values()].flatMap((entry) => (entry === null ? [] : [entry]));
  ended.sort((a, b) => b.seq - a.seq);
  for (const entry of ended.slice(0, window)) counts[entry.outcome] += 1;
  return counts;
}
