import { describe, expect, it } from "vitest";
import { BudgetError, budgetState, consumeBudget, declareBudget, raiseBudget } from "../../src/core/budget.js";
import { Ledger } from "../../src/core/ledger.js";
import { makeTempDir } from "../helpers/tmp.js";

const newLedger = (): Ledger => new Ledger(makeTempDir("omf-budget-"));

describe("budgets", () => {
  it("is null until declared", () => {
    expect(budgetState(newLedger(), "g-a")).toBeNull();
  });

  it("tracks declared, raised and consumed rounds per goal", () => {
    const ledger = newLedger();
    declareBudget(ledger, "g-a", 3, "human:dev");
    declareBudget(ledger, "g-b", 1, "human:dev");
    consumeBudget(ledger, "g-a");
    raiseBudget(ledger, "g-a", 2, "human:dev");
    expect(budgetState(ledger, "g-a")).toEqual({ declared: 3, raised: 2, consumed: 1, remaining: 4 });
    expect(budgetState(ledger, "g-b")).toEqual({ declared: 1, raised: 0, consumed: 0, remaining: 1 });
  });

  it("only people declare budgets", () => {
    expect(() => declareBudget(newLedger(), "g-a", 3, "agent:claude")).toThrow(BudgetError);
  });

  it("rejects non-positive or fractional rounds", () => {
    const ledger = newLedger();
    expect(() => declareBudget(ledger, "g-a", 0, "human:dev")).toThrow(BudgetError);
    expect(() => declareBudget(ledger, "g-a", 1.5, "human:dev")).toThrow(BudgetError);
  });

  it("refuses to consume an undeclared budget", () => {
    expect(() => consumeBudget(newLedger(), "g-a")).toThrow(/no budget declared/);
  });
});
