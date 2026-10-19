import { type ReasonCode, type Recommendation, W_REASON_CODES } from "./w-events.js";

/**
 * Outcome-to-state table (spec §4.4 step 5). It maps what a run ended with to what happens to the item
 * and whether the result counts toward STOP_IF. It does not classify (that is the classifier) and it changes no
 * transition: `src/work/transitions.ts` stays as it is. No row reaches `done`; only a person completes an item.
 */

export type WOutcome = "success" | "flawed" | "blocked" | "manual";
export const W_OUTCOMES: readonly WOutcome[] = ["success", "flawed", "blocked", "manual"];

export interface OutcomeInput {
  outcome: WOutcome;
  /** Hard GATE-4 exhaustion or unrecoverable infrastructure. Only flawed and blocked may set it. */
  exhausted: boolean;
  /** null for success (its event carries none); a closed code for flawed, blocked and manual. */
  reason_code: ReasonCode | null;
  /** An unmeasured quantitative decision forces `human_needed`. Only success may set it. */
  human_needed?: boolean;
}

export type Disposition =
  | { action: "submit"; item_state: "awaiting_review"; recommendation: Recommendation; counts_toward_stop_if: true }
  | { action: "fail"; item_state: "failed"; counts_toward_stop_if: false }
  // The item stays where it is: ready when it never started, in_progress when it did.
  | { action: "park"; item_state: "unchanged"; counts_toward_stop_if: false };

export interface OutcomeRow {
  outcome: WOutcome;
  exhausted: boolean;
  disposition: Disposition;
}

/** The six rows of the outcome table. `manual` with exhaustion and `success` with exhaustion do not exist. */
export const OUTCOME_ROWS: readonly OutcomeRow[] = [
  {
    outcome: "success",
    exhausted: false,
    disposition: {
      action: "submit",
      item_state: "awaiting_review",
      recommendation: "merge_recommended",
      counts_toward_stop_if: true,
    },
  },
  {
    outcome: "flawed",
    exhausted: false,
    disposition: {
      action: "submit",
      item_state: "awaiting_review",
      recommendation: "not_recommended",
      counts_toward_stop_if: true,
    },
  },
  {
    outcome: "flawed",
    exhausted: true,
    disposition: { action: "fail", item_state: "failed", counts_toward_stop_if: false },
  },
  {
    outcome: "blocked",
    exhausted: true,
    disposition: { action: "fail", item_state: "failed", counts_toward_stop_if: false },
  },
  {
    outcome: "blocked",
    exhausted: false,
    disposition: { action: "park", item_state: "unchanged", counts_toward_stop_if: false },
  },
  {
    outcome: "manual",
    exhausted: false,
    disposition: { action: "park", item_state: "unchanged", counts_toward_stop_if: false },
  },
];

/** Messages hold closed values only (outcome names, flags), never a caller's string. */
export class OutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutcomeError";
  }
}

/** What happens for this input, or an OutcomeError for an impossible row or an input that breaks the closed grammar. */
export function dispositionOf(input: OutcomeInput): Disposition {
  if (!W_OUTCOMES.includes(input.outcome)) throw new OutcomeError("unknown outcome");
  const row = OUTCOME_ROWS.find((r) => r.outcome === input.outcome && r.exhausted === input.exhausted);
  if (row === undefined)
    throw new OutcomeError(`no outcome row for ${input.outcome} with exhausted=${input.exhausted}`);
  if (input.outcome === "success") {
    if (input.reason_code !== null) throw new OutcomeError("a success carries no reason_code");
  } else if (input.reason_code === null || !(W_REASON_CODES as readonly string[]).includes(input.reason_code)) {
    throw new OutcomeError(`${input.outcome} needs a reason_code from the closed list`);
  }
  if (input.human_needed === true) {
    if (input.outcome !== "success") throw new OutcomeError("human_needed is valid only on success");
    return {
      action: "submit",
      item_state: "awaiting_review",
      recommendation: "human_needed",
      counts_toward_stop_if: true,
    };
  }
  return { ...row.disposition };
}
