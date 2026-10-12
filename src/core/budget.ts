import type { Ledger } from "./ledger.js";

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

/** Derived from the verified ledger, so restarting a process cannot change it. */
export function budgetState(ledger: Ledger, goalId: string): BudgetState | null {
  let declared: number | null = null;
  let raised = 0;
  let consumed = 0;
  for (const event of ledger.readVerified()) {
    if (event.payload.goal_id !== goalId) continue;
    const rounds = Number(event.payload.rounds ?? 0);
    if (event.type === "budget.declared") declared = rounds;
    else if (event.type === "budget.raised") raised += rounds;
    else if (event.type === "budget.consumed") consumed += rounds;
  }
  if (declared === null) return null;
  return { declared, raised, consumed, remaining: declared + raised - consumed };
}

export function declareBudget(ledger: Ledger, goalId: string, rounds: number, actor: string): void {
  requireHuman(actor, "declare");
  requirePositiveInteger(rounds);
  if (budgetState(ledger, goalId) !== null) {
    throw new BudgetError(`budget already declared for ${goalId}; raise it instead`);
  }
  ledger.append({ actor, type: "budget.declared", payload: { goal_id: goalId, rounds } });
}

export function raiseBudget(ledger: Ledger, goalId: string, rounds: number, actor: string): void {
  requireHuman(actor, "raise");
  requirePositiveInteger(rounds);
  if (budgetState(ledger, goalId) === null) throw new BudgetError(`no budget declared for ${goalId}`);
  ledger.append({ actor, type: "budget.raised", payload: { goal_id: goalId, rounds } });
}

export function consumeBudget(ledger: Ledger, goalId: string, rounds = 1, actor = "omf"): BudgetState {
  requirePositiveInteger(rounds);
  const state = budgetState(ledger, goalId);
  if (state === null) throw new BudgetError(`no budget declared for ${goalId}`);
  if (state.remaining < rounds) throw new BudgetError(`budget exhausted for ${goalId}`);
  ledger.append({ actor, type: "budget.consumed", payload: { goal_id: goalId, rounds } });
  return { ...state, consumed: state.consumed + rounds, remaining: state.remaining - rounds };
}
