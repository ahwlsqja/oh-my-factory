import { describe, expect, it } from "vitest";
import { BudgetError, budgetConsumedEvent, budgetState, consumeBudget, declareBudget, raiseBudget } from "../../src/core/budget.js";
import { Ledger } from "../../src/core/ledger.js";
import { makeTempDir } from "../helpers/tmp.js";

const newLedger = (): Ledger => new Ledger(makeTempDir("omf-budget-"));

describe("budgets", () => {
  it("is null until declared", () => {
    expect(budgetState(newLedger(), "g-a", "rounds")).toBeNull();
  });

  it("tracks declared, raised and consumed rounds per goal", () => {
    const ledger = newLedger();
    declareBudget(ledger, "g-a", "rounds", 3, "human:dev");
    declareBudget(ledger, "g-b", "rounds", 1, "human:dev");
    consumeBudget(ledger, "g-a", "rounds");
    raiseBudget(ledger, "g-a", "rounds", 2, "human:dev");
    expect(budgetState(ledger, "g-a", "rounds")).toEqual({ kind: "rounds", declared: 3, raised: 2, consumed: 1, remaining: 4 });
    expect(budgetState(ledger, "g-b", "rounds")).toEqual({ kind: "rounds", declared: 1, raised: 0, consumed: 0, remaining: 1 });
  });

  it("only people declare budgets", () => {
    expect(() => declareBudget(newLedger(), "g-a", "rounds", 3, "agent:claude")).toThrow(BudgetError);
  });

  it("rejects non-positive or fractional rounds", () => {
    const ledger = newLedger();
    expect(() => declareBudget(ledger, "g-a", "rounds", 0, "human:dev")).toThrow(BudgetError);
    expect(() => declareBudget(ledger, "g-a", "rounds", 1.5, "human:dev")).toThrow(BudgetError);
  });

  it("refuses to consume an undeclared budget", () => {
    expect(() => consumeBudget(newLedger(), "g-a", "rounds")).toThrow(/no budget declared/);
  });

  it("stops on a raise written by a non-person", () => {
    const ledger = newLedger();
    declareBudget(ledger, "g-a", "rounds", 3, "human:dev");
    ledger.append({ actor: "agent:codex", type: "budget.raised", payload: { goal_id: "g-a", kind: "rounds", amount: 5 } });
    expect(() => budgetState(ledger, "g-a", "rounds")).toThrow(/budget.raised by agent:codex/);
  });

  it("stops on a second declaration written directly", () => {
    const ledger = newLedger();
    declareBudget(ledger, "g-a", "rounds", 3, "human:dev");
    ledger.append({ actor: "human:dev", type: "budget.declared", payload: { goal_id: "g-a", kind: "rounds", amount: 9 } });
    expect(() => budgetState(ledger, "g-a", "rounds")).toThrow(/declared twice/);
  });

  it("stops on rounds that are not positive integers", () => {
    const negative = newLedger();
    declareBudget(negative, "g-a", "rounds", 3, "human:dev");
    negative.append({ actor: "omf", type: "budget.consumed", payload: { goal_id: "g-a", kind: "rounds", amount: -5 } });
    expect(() => budgetState(negative, "g-a", "rounds")).toThrow(/positive integer/);

    const text = newLedger();
    declareBudget(text, "g-a", "rounds", 3, "human:dev");
    text.append({ actor: "omf", type: "budget.consumed", payload: { goal_id: "g-a", kind: "rounds", amount: "x" } });
    expect(() => budgetState(text, "g-a", "rounds")).toThrow(/positive integer/);
  });

  it("agents cannot record consumption", () => {
    const ledger = newLedger();
    declareBudget(ledger, "g-a", "rounds", 3, "human:dev");
    expect(() => consumeBudget(ledger, "g-a", "rounds", 1, "agent:claude")).toThrow(BudgetError);
  });
});

describe("budget kinds and codes", () => {
  const codeOf = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (err) {
      return err instanceof BudgetError ? err.code : "not a BudgetError";
    }
    return undefined;
  };

  it("keeps rounds and disclosure budgets apart", () => {
    const ledger = newLedger();
    declareBudget(ledger, "g-a", "rounds", 3, "human:dev");
    declareBudget(ledger, "g-a", "disclosure", 2, "human:dev");
    consumeBudget(ledger, "g-a", "disclosure");
    expect(budgetState(ledger, "g-a", "rounds")).toEqual({ kind: "rounds", declared: 3, raised: 0, consumed: 0, remaining: 3 });
    expect(budgetState(ledger, "g-a", "disclosure")).toEqual({
      kind: "disclosure",
      declared: 2,
      raised: 0,
      consumed: 1,
      remaining: 1,
    });
  });

  it("returns the written event from declare and raise", () => {
    const ledger = newLedger();
    const declared = declareBudget(ledger, "g-a", "rounds", 3, "human:dev");
    const raised = raiseBudget(ledger, "g-a", "rounds", 2, "human:dev");
    expect(declared).toMatchObject({ type: "budget.declared", payload: { goal_id: "g-a", kind: "rounds", amount: 3 } });
    expect(raised).toMatchObject({ seq: declared.seq + 1, type: "budget.raised", payload: { amount: 2 } });
  });

  it("tags each failure with a code", () => {
    const ledger = newLedger();
    expect(codeOf(() => declareBudget(ledger, "g-a", "rounds", 1, "agent:x"))).toBe("forbidden");
    expect(codeOf(() => declareBudget(ledger, "g-a", "rounds", 0, "human:dev"))).toBe("invalid_amount");
    expect(codeOf(() => consumeBudget(ledger, "g-a", "rounds"))).toBe("not_declared");
    declareBudget(ledger, "g-a", "rounds", 1, "human:dev");
    expect(codeOf(() => declareBudget(ledger, "g-a", "rounds", 1, "human:dev"))).toBe("already_declared");
    consumeBudget(ledger, "g-a", "rounds");
    expect(codeOf(() => consumeBudget(ledger, "g-a", "rounds"))).toBe("exhausted");
    ledger.append({ actor: "omf", type: "budget.consumed", payload: { goal_id: "g-a", kind: "tokens", amount: 1 } });
    expect(codeOf(() => budgetState(ledger, "g-a", "rounds"))).toBe("invalid_event");
  });
});

describe("budgetConsumedEvent", () => {
  it("is the event consumeBudget writes, as a pure value", () => {
    expect(budgetConsumedEvent("g-a", "disclosure", 1)).toEqual({
      actor: "omf",
      type: "budget.consumed",
      payload: { goal_id: "g-a", kind: "disclosure", amount: 1 },
    });
    const ledger = newLedger();
    declareBudget(ledger, "g-a", "disclosure", 2, "human:dev");
    consumeBudget(ledger, "g-a", "disclosure");
    const written = ledger.readVerified().at(-1);
    expect({ actor: written?.actor, type: written?.type, payload: written?.payload }).toEqual(
      budgetConsumedEvent("g-a", "disclosure", 1),
    );
  });

  it("refuses an amount that is not a positive integer", () => {
    expect(() => budgetConsumedEvent("g-a", "rounds", 0)).toThrow(BudgetError);
    expect(() => budgetConsumedEvent("g-a", "rounds", 1.5)).toThrow(BudgetError);
  });
});
