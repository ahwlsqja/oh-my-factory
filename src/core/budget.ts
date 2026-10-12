import type { Ledger, LedgerEvent } from "./ledger.js";

export class BudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetError";
  }
}

export interface BudgetState {
  declared: number;
  raised: number;
  consumed: number;
  remaining: number;
}

const BUDGET_TYPES = new Set(["budget.declared", "budget.raised", "budget.consumed"]);

function requireHuman(actor: string, action: string): void {
  if (!actor.startsWith("human:")) {
    throw new BudgetError(`only a person may ${action} a budget (J8); actor was ${actor}`);
  }
}

function requirePositiveInteger(rounds: number): void {
  if (!Number.isInteger(rounds) || rounds <= 0) {
    throw new BudgetError(`rounds must be a positive integer; got ${rounds}`);
  }
}

function invalid(event: LedgerEvent, why: string): BudgetError {
  return new BudgetError(`invalid budget event at seq ${event.seq}: ${why}`);
}

/**
 * Budget state for one goal, derived from verified ledger events (spec §4.4, J8). Nothing is cached,
 * so a restart cannot change it, and a second declaration cannot reset it.
 *
 * A budget event that breaks the rules was written outside these functions: a non-person declaring or
 * raising, a second declaration, consumption before declaration, or rounds that are not a positive
 * integer. That stops the line instead of being skipped.
 *
 * Known limit: removing events from the end of the ledger is not detected (see Ledger), so a person who
 * can edit ~/.omf can undo consumption.
 */
export function budgetStateFromEvents(events: LedgerEvent[], goalId: string): BudgetState | null {
  let declared: number | null = null;
  let raised = 0;
  let consumed = 0;
  for (const event of events) {
    if (!BUDGET_TYPES.has(event.type) || event.payload.goal_id !== goalId) continue;
    const rounds = event.payload.rounds;
    if (typeof rounds !== "number" || !Number.isInteger(rounds) || rounds <= 0) {
      throw invalid(event, "rounds must be a positive integer");
    }
    if (event.type === "budget.consumed") {
      if (declared === null) throw invalid(event, "consumed before declared");
      consumed += rounds;
      continue;
    }
    if (!event.actor.startsWith("human:")) throw invalid(event, `${event.type} by ${event.actor}`);
    if (event.type === "budget.declared") {
      if (declared !== null) throw invalid(event, `${goalId} declared twice`);
      declared = rounds;
    } else {
      if (declared === null) throw invalid(event, "raised before declared");
      raised += rounds;
    }
  }
  if (declared === null) return null;
  return { declared, raised, consumed, remaining: declared + raised - consumed };
}

export function budgetState(ledger: Ledger, goalId: string): BudgetState | null {
  return budgetStateFromEvents(ledger.readVerified(), goalId);
}

export function declareBudget(ledger: Ledger, goalId: string, rounds: number, actor: string): void {
  requireHuman(actor, "declare");
  requirePositiveInteger(rounds);
  ledger.appendWith((events) => {
    if (budgetStateFromEvents(events, goalId) !== null) {
      throw new BudgetError(`budget already declared for ${goalId}; raise it instead`);
    }
    return { actor, type: "budget.declared", payload: { goal_id: goalId, rounds } };
  });
}

export function raiseBudget(ledger: Ledger, goalId: string, rounds: number, actor: string): void {
  requireHuman(actor, "raise");
  requirePositiveInteger(rounds);
  ledger.appendWith((events) => {
    if (budgetStateFromEvents(events, goalId) === null) throw new BudgetError(`no budget declared for ${goalId}`);
    return { actor, type: "budget.raised", payload: { goal_id: goalId, rounds } };
  });
}

/** Consumption is recorded by omf itself or by a person, never by an agent. Check and write share one lock. */
export function consumeBudget(ledger: Ledger, goalId: string, rounds = 1, actor = "omf"): BudgetState {
  requirePositiveInteger(rounds);
  if (actor !== "omf" && !actor.startsWith("human:")) {
    throw new BudgetError(`only omf or a person records budget consumption; actor was ${actor}`);
  }
  const outcome: { after?: BudgetState } = {};
  ledger.appendWith((events) => {
    const state = budgetStateFromEvents(events, goalId);
    if (state === null) throw new BudgetError(`no budget declared for ${goalId}`);
    if (state.remaining < rounds) throw new BudgetError(`budget exhausted for ${goalId}`);
    outcome.after = { ...state, consumed: state.consumed + rounds, remaining: state.remaining - rounds };
    return { actor, type: "budget.consumed", payload: { goal_id: goalId, rounds } };
  });
  if (outcome.after === undefined) throw new Error("unreachable: consumption was not computed");
  return outcome.after;
}
