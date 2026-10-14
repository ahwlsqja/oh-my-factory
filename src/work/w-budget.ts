/**
 * The per-item budget of a W run, kept in the ledger (M3b2-D1, spec §5.0 GATE-4). A limit is copied from
 * config `[w]` at the item's first run, raised only by a person (J8), and consumed by `work.round` and
 * `work.spend` events that OMF appends under the run's claim. Because the counts are folded from the
 * ledger, a restart or a kill cannot reset them (the M2b `budget.consumed` pattern).
 */

/** The four event types of this file; schemas/work-budget-event.schema.json holds their payloads. */
export const WORK_BUDGET_EVENT_TYPES = ["work.limits_set", "work.limit_raised", "work.round", "work.spend"] as const;
export type WorkBudgetEventType = (typeof WORK_BUDGET_EVENT_TYPES)[number];

export type LimitKind = "rounds" | "model_micro_usd";
export const LIMIT_KINDS: readonly LimitKind[] = ["rounds", "model_micro_usd"];

export interface WorkLimits {
  max_rounds: number;
  max_model_micro_usd: number;
}

/**
 * Dollars to whole micro-dollars (M3b2-D2). Floats drift when summed, so the ledger stores integers and the
 * config's dollars are converted once, here. Refuses anything that is not a positive finite amount whose
 * result is a safe integer of at least 1.
 */
export function microUsd(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) throw new RangeError("usd must be a positive finite number");
  const micro = Math.round(usd * 1e6);
  if (micro < 1 || !Number.isSafeInteger(micro)) throw new RangeError("usd is outside the range of whole micro-dollars");
  return micro;
}
