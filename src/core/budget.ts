import type { Ledger, LedgerEvent, NewEvent } from "./ledger.js";

/** What a budget counts: goal-loop rounds (spec §4.4) or S6 disclosures (spec §5.7). */
export type BudgetKind = "rounds" | "disclosure";

export const BUDGET_KINDS: readonly BudgetKind[] = ["rounds", "disclosure"];

/**
 * Why a budget call failed. `exhausted` is the one the goal loop escalates to J6. `invalid_event` means
 * the ledger holds a budget event that breaks the rules, which stops the line.
 */
export type BudgetErrorCode =
  | "forbidden"
  | "invalid_amount"
  | "not_declared"
  | "already_declared"
  | "exhausted"
  | "invalid_event";

export class BudgetError extends Error {
  constructor(
    readonly code: BudgetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BudgetError";
  }
}

export interface BudgetState {
  kind: BudgetKind;
  declared: number;
  raised: number;
  consumed: number;
  remaining: number;
}

const BUDGET_TYPES = new Set(["budget.declared", "budget.raised", "budget.consumed"]);

function isBudgetKind(value: unknown): value is BudgetKind {
  return typeof value === "string" && (BUDGET_KINDS as readonly string[]).includes(value);
}

function requireHuman(actor: string, action: string): void {
  if (!actor.startsWith("human:")) {
    throw new BudgetError("forbidden", `only a person may ${action} a budget (J8); actor was ${actor}`);
  }
}

function requirePositiveInteger(amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new BudgetError("invalid_amount", `amount must be a positive integer; got ${amount}`);
  }
}

function invalid(event: LedgerEvent, why: string): BudgetError {
  return new BudgetError("invalid_event", `invalid budget event at seq ${event.seq}: ${why}`);
}

/**
 * Budget state for one goal and kind, derived from verified ledger events (spec §4.4, J8). Nothing is
 * cached, so a restart cannot change it, and a second declaration cannot reset it.
 *
 * A budget event that breaks the rules was written outside these functions: an unknown kind, a
 * non-person declaring or raising, a second declaration, consumption before declaration, or an amount
 * that is not a positive integer. That stops the line instead of being skipped.
 *
 * Known limit: removing events from the end of the ledger is not detected (see Ledger), so a person who
 * can edit ~/.omf can undo consumption.
 */
export function budgetStateFromEvents(
  events: readonly LedgerEvent[],
  goalId: string,
  kind: BudgetKind,
): BudgetState | null {
  let declared: number | null = null;
  let raised = 0;
  let consumed = 0;
  for (const event of events) {
    if (!BUDGET_TYPES.has(event.type) || event.payload.goal_id !== goalId) continue;
    if (!isBudgetKind(event.payload.kind)) throw invalid(event, `unknown kind ${String(event.payload.kind)}`);
    if (event.payload.kind !== kind) continue;
    const amount = event.payload.amount;
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
      throw invalid(event, "amount must be a positive integer");
    }
    if (event.type === "budget.consumed") {
      if (declared === null) throw invalid(event, "consumed before declared");
      consumed += amount;
      continue;
    }
    if (!event.actor.startsWith("human:")) throw invalid(event, `${event.type} by ${event.actor}`);
    if (event.type === "budget.declared") {
      if (declared !== null) throw invalid(event, `${kind} budget for ${goalId} declared twice`);
      declared = amount;
    } else {
      if (declared === null) throw invalid(event, "raised before declared");
      raised += amount;
    }
  }
  if (declared === null) return null;
  return { kind, declared, raised, consumed, remaining: declared + raised - consumed };
}

export function budgetState(ledger: Ledger, goalId: string, kind: BudgetKind): BudgetState | null {
  return budgetStateFromEvents(ledger.readVerified(), goalId, kind);
}

export function declareBudget(
  ledger: Ledger,
  goalId: string,
  kind: BudgetKind,
  amount: number,
  actor: string,
): LedgerEvent {
  requireHuman(actor, "declare");
  requirePositiveInteger(amount);
  return ledger.appendWith((events) => {
    if (budgetStateFromEvents(events, goalId, kind) !== null) {
      throw new BudgetError("already_declared", `${kind} budget already declared for ${goalId}; raise it instead`);
    }
    return { actor, type: "budget.declared", payload: { goal_id: goalId, kind, amount } };
  });
}

export function raiseBudget(
  ledger: Ledger,
  goalId: string,
  kind: BudgetKind,
  amount: number,
  actor: string,
): LedgerEvent {
  requireHuman(actor, "raise");
  requirePositiveInteger(amount);
  return ledger.appendWith((events) => {
    if (budgetStateFromEvents(events, goalId, kind) === null) {
      throw new BudgetError("not_declared", `no budget declared for ${goalId} (${kind})`);
    }
    return { actor, type: "budget.raised", payload: { goal_id: goalId, kind, amount } };
  });
}

/**
 * The `budget.consumed` event as a value, with no ledger access. A caller that must write a unit together with
 * the record it pays for (releaseFeedback writes this and `feedback.released` in one `appendWithMany`, spec §5.7)
 * builds it here, so the shape stays the one `budgetStateFromEvents` folds. It does not check the budget: the
 * caller decides under the ledger lock, and the fold re-validates the event on the next read.
 */
export function budgetConsumedEvent(goalId: string, kind: BudgetKind, amount = 1): NewEvent {
  requirePositiveInteger(amount);
  return { actor: "omf", type: "budget.consumed", payload: { goal_id: goalId, kind, amount } };
}

/** Consumption is recorded by omf itself or by a person, never by an agent. Check and write share one lock. */
export function consumeBudget(
  ledger: Ledger,
  goalId: string,
  kind: BudgetKind,
  amount = 1,
  actor = "omf",
): BudgetState {
  requirePositiveInteger(amount);
  if (actor !== "omf" && !actor.startsWith("human:")) {
    throw new BudgetError("forbidden", `only omf or a person records budget consumption; actor was ${actor}`);
  }
  const outcome: { after?: BudgetState } = {};
  ledger.appendWith((events) => {
    const state = budgetStateFromEvents(events, goalId, kind);
    if (state === null) throw new BudgetError("not_declared", `no budget declared for ${goalId} (${kind})`);
    if (state.remaining < amount) throw new BudgetError("exhausted", `budget exhausted for ${goalId} (${kind})`);
    outcome.after = { ...state, consumed: state.consumed + amount, remaining: state.remaining - amount };
    return { ...budgetConsumedEvent(goalId, kind, amount), actor };
  });
  if (outcome.after === undefined) throw new Error("unreachable: consumption was not computed");
  return outcome.after;
}
