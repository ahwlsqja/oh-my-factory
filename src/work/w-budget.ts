import type { LedgerEvent } from "../core/ledger.js";
import { validate } from "../core/schema.js";


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

const SCHEMA = "work-budget-event.schema.json";
const TYPE_SET: ReadonlySet<string> = new Set(WORK_BUDGET_EVENT_TYPES);
const HUMAN = /^human:\S+$/;
const saturate = (n: number): number => Math.min(n, Number.MAX_SAFE_INTEGER);

/** Why an event was not counted. Closed codes: an anomaly never carries the rejected payload. */
export type BudgetAnomalyCode =
  | "invalid_event" // the payload fails the schema
  | "not_omf" // limits, round or spend written by someone other than omf
  | "not_human" // a raise written by someone other than a person
  | "limits_twice" // the first work.limits_set wins
  | "raise_before_limits"
  | "round_gap"; // a work.round whose number is not rounds_started + 1
export interface BudgetAnomaly {
  code: BudgetAnomalyCode;
  seq: number;
}

export interface WorkBudgetState {
  /** From work.limits_set; null = never recorded. */
  limits: WorkLimits | null;
  /** Sum of the raises a person recorded. */
  raised: { rounds: number; model_micro_usd: number };
  /** limits + raised; null while limits is null. */
  effective: WorkLimits | null;
  /** Count of valid work.round events. */
  rounds_started: number;
  /** prev_signature of the latest valid work.round. */
  previous_signature: string | null;
  /** A null micro_usd counts as unknown and adds nothing. */
  spend: { micro_usd: number; unknown_count: number };
  /** Any anomaly fails GATE-4 closed (Task 3). The offending event counts for nothing. */
  anomalies: BudgetAnomaly[];
}

/**
 * Folds the verified events of one work item into its budget (M3b2-D1 to D3). Pure. Events of other items
 * and every non-budget type are skipped. An invalid event whose `work_id` is missing or malformed names no
 * item, so no item's fold sees it; one that names this item is an `invalid_event` anomaly. Sums saturate at
 * the largest safe integer, so an absurd amount still reads as "over the limit" instead of wrapping.
 */
export function foldWorkBudget(events: readonly LedgerEvent[], workId: string): WorkBudgetState {
  let limits: WorkLimits | null = null;
  const raised = { rounds: 0, model_micro_usd: 0 };
  let roundsStarted = 0;
  let previous: string | null = null;
  const spend = { micro_usd: 0, unknown_count: 0 };
  const anomalies: BudgetAnomaly[] = [];
  const flag = (code: BudgetAnomalyCode, seq: number): void => {
    anomalies.push({ code, seq });
  };

  for (const event of events) {
    if (!TYPE_SET.has(event.type) || event.payload.work_id !== workId) continue;
    if (!validate(SCHEMA, { type: event.type, payload: event.payload }).ok) {
      flag("invalid_event", event.seq);
      continue;
    }
    const payload = event.payload;
    if (event.type === "work.limit_raised") {
      if (!HUMAN.test(event.actor)) flag("not_human", event.seq);
      else if (limits === null) flag("raise_before_limits", event.seq);
      else {
        const { kind, amount } = payload as { kind: LimitKind; amount: number };
        raised[kind] = saturate(raised[kind] + amount);
      }
      continue;
    }
    if (event.actor !== "omf") {
      flag("not_omf", event.seq);
      continue;
    }
    if (event.type === "work.limits_set") {
      if (limits !== null) flag("limits_twice", event.seq);
      else {
        const set = payload as unknown as WorkLimits;
        limits = { max_rounds: set.max_rounds, max_model_micro_usd: set.max_model_micro_usd };
      }
    } else if (event.type === "work.round") {
      const { round, prev_signature } = payload as { round: number; prev_signature: string | null };
      if (round !== roundsStarted + 1) flag("round_gap", event.seq);
      else {
        roundsStarted = round;
        previous = prev_signature;
      }
    } else {
      const { micro_usd } = payload as { micro_usd: number | null };
      if (micro_usd === null) spend.unknown_count += 1;
      else spend.micro_usd = saturate(spend.micro_usd + micro_usd);
    }
  }

  const effective: WorkLimits | null =
    limits === null
      ? null
      : {
          max_rounds: saturate(limits.max_rounds + raised.rounds),
          max_model_micro_usd: saturate(limits.max_model_micro_usd + raised.model_micro_usd),
        };
  return { limits, raised, effective, rounds_started: roundsStarted, previous_signature: previous, spend, anomalies };
}
