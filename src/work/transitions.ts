import type { WorkState } from "./types.js";

/**
 * Allowed work item state changes. Veto and cancel are allowed from every open state, `in_progress`
 * included: the person can stop an auto-dispatched item at any time (spec §4.4 step 5), and the store
 * takes only `item.lock` for them, so a live `claim.lock` never blocks a veto. `awaiting_approval` has no
 * edge to `in_progress`: a high-risk item reaches work only through `ready`, which only a person's
 * approval opens (spec §6.2).
 */
export const TRANSITIONS: Readonly<Record<WorkState, readonly WorkState[]>> = {
  ready: ["in_progress", "vetoed", "cancelled"],
  awaiting_approval: ["ready", "vetoed", "cancelled"],
  in_progress: ["awaiting_review", "failed", "vetoed", "cancelled"],
  awaiting_review: ["done", "failed", "vetoed", "cancelled"],
  done: [],
  failed: [],
  vetoed: [],
  cancelled: [],
};

export function canTransition(from: WorkState, to: WorkState): boolean {
  return TRANSITIONS[from].includes(to);
}
