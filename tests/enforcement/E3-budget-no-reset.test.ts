import { describe, expect, it } from "vitest";
import { BudgetError, budgetState, consumeBudget, declareBudget, raiseBudget } from "../../src/core/budget.js";
import { Ledger } from "../../src/core/ledger.js";
import { makeTempDir } from "../helpers/tmp.js";

// Spec §4.4, J8: budgets accumulate in the host ledger. A restart or a re-declaration cannot reset them,
// and only people declare or raise them. Known limit (spec §8): removing events from the end of the
// ledger is not detected, so someone who can edit ~/.omf can undo consumption.
describe("E3 budget-no-reset", () => {
  it("survives a restart: a new Ledger instance sees the same consumption", () => {
    const dir = makeTempDir("omf-e3-");
    const before = new Ledger(dir);
    declareBudget(before, "g-a", 3, "human:dev");
    consumeBudget(before, "g-a");
    consumeBudget(before, "g-a");

    const afterRestart = new Ledger(dir);
    expect(budgetState(afterRestart, "g-a")?.remaining).toBe(1);
    consumeBudget(afterRestart, "g-a");
    expect(() => consumeBudget(afterRestart, "g-a")).toThrow(/budget exhausted/);
  });

  it("cannot be re-declared to reset it", () => {
    const ledger = new Ledger(makeTempDir("omf-e3-"));
    declareBudget(ledger, "g-a", 1, "human:dev");
    consumeBudget(ledger, "g-a");
    expect(() => declareBudget(ledger, "g-a", 5, "human:dev")).toThrow(/already declared/);
  });

  it("cannot be raised by omf or an agent", () => {
    const ledger = new Ledger(makeTempDir("omf-e3-"));
    declareBudget(ledger, "g-a", 1, "human:dev");
    expect(() => raiseBudget(ledger, "g-a", 1, "omf")).toThrow(BudgetError);
    expect(() => raiseBudget(ledger, "g-a", 1, "agent:codex")).toThrow(BudgetError);
    expect(budgetState(ledger, "g-a")?.remaining).toBe(1);
  });
});
