import { describe, expect, it } from "vitest";
import {
  BudgetError,
  type BudgetKind,
  budgetState,
  consumeBudget,
  declareBudget,
  raiseBudget,
} from "../../src/core/budget.js";
import { Ledger } from "../../src/core/ledger.js";
import { resumeGoal } from "../../src/goal/lifecycle.js";
import type { TickResult } from "../../src/goal/tick.js";
import { omf } from "../helpers/cli.js";
import {
  type EnforcementFixture,
  ledgerEvents,
  setReading,
  setupEnforcementGoal,
  tickCli,
  useCleanModel,
} from "../helpers/enforcement-goal.js";
import { makeTempDir } from "../helpers/tmp.js";

// Spec §4.4, J8: budgets accumulate in the host ledger. A restart or a re-declaration cannot reset them,
// and only people declare or raise them. Known limit (spec §8): removing events from the end of the
// ledger is not detected, so someone who can edit ~/.omf can undo consumption.
describe("E3 budget-no-reset", () => {
  it("survives a restart: a new Ledger instance sees the same consumption", () => {
    const dir = makeTempDir("omf-e3-");
    const before = new Ledger(dir);
    declareBudget(before, "g-a", "rounds", 3, "human:dev");
    consumeBudget(before, "g-a", "rounds");
    consumeBudget(before, "g-a", "rounds");

    const afterRestart = new Ledger(dir);
    expect(budgetState(afterRestart, "g-a", "rounds")?.remaining).toBe(1);
    consumeBudget(afterRestart, "g-a", "rounds");
    expect(() => consumeBudget(afterRestart, "g-a", "rounds")).toThrow(/budget exhausted/);
  });

  it("cannot be re-declared to reset it", () => {
    const ledger = new Ledger(makeTempDir("omf-e3-"));
    declareBudget(ledger, "g-a", "rounds", 1, "human:dev");
    consumeBudget(ledger, "g-a", "rounds");
    expect(() => declareBudget(ledger, "g-a", "rounds", 5, "human:dev")).toThrow(/already declared/);
  });

  it("cannot be raised by omf or an agent", () => {
    const ledger = new Ledger(makeTempDir("omf-e3-"));
    declareBudget(ledger, "g-a", "rounds", 1, "human:dev");
    expect(() => raiseBudget(ledger, "g-a", "rounds", 1, "omf")).toThrow(BudgetError);
    expect(() => raiseBudget(ledger, "g-a", "rounds", 1, "agent:codex")).toThrow(BudgetError);
    expect(budgetState(ledger, "g-a", "rounds")?.remaining).toBe(1);
  });
});

// The same promise at the level of `omf goal tick` (spec §4.4, J8). Every CLI run is a fresh process, so a
// tick that sees fewer rounds than the last one left is a budget that was refilled by a restart. A round is
// consumed only by a tick that calls the reconciler (D18); each tick below changes the reading so the
// progress signature moves and the stall guard (J6) does not fire before the budget check.
describe("E3 budget-no-reset at tick level", () => {
  const left = (fx: EnforcementFixture, kind: BudgetKind): number | undefined =>
    budgetState(new Ledger(fx.location.dir), fx.goalId, kind)?.remaining;
  const spent = (fx: EnforcementFixture, kind: BudgetKind): number =>
    ledgerEvents(fx, "budget.consumed").filter((e) => e.payload.kind === kind).length;
  const modelCalls = (fx: EnforcementFixture): number => ledgerEvents(fx, "reconcile.requested").length;
  const resultOf = (run: { stdout: string }): TickResult => JSON.parse(run.stdout) as TickResult;

  it("a restarted process keeps the rounds already spent, a tick at zero never calls the model, and only a person adds rounds", () => {
    const fx = setupEnforcementGoal({ rounds: 2 });
    useCleanModel(fx);

    expect(tickCli(fx).code).toBe(0);
    expect(left(fx, "rounds")).toBe(1);
    setReading(fx, 4100);
    expect(tickCli(fx).code).toBe(0);
    expect(left(fx, "rounds")).toBe(0);
    expect(modelCalls(fx)).toBe(2);

    setReading(fx, 4200);
    const exhausted = tickCli(fx, ["--json"]);
    expect(exhausted.code).toBe(1);
    expect(resultOf(exhausted).status).toBe("blocked_on_user");
    expect(resultOf(exhausted).escalation).toMatchObject({ j: "J8", reason_code: "rounds_exhausted" });
    expect(modelCalls(fx), "no model call at zero rounds").toBe(2);
    expect(spent(fx, "rounds"), "nothing is consumed on exhaustion").toBe(2);

    // The goal stays stopped and a tick writes nothing.
    const eventsBefore = ledgerEvents(fx).length;
    const stopped = tickCli(fx, ["--json"]);
    expect(stopped.code).toBe(1);
    expect(resultOf(stopped).outcome).toBe("stopped_until_resumed");
    expect(ledgerEvents(fx)).toHaveLength(eventsBefore);

    // Rounds come back only through a person. The CLI needs a terminal, and omf cannot raise its own budget.
    const raise = omf(["budget", "raise", fx.goalId, "rounds", "1"], fx.repo, fx.home);
    expect(raise.code).toBe(2);
    expect(raise.stderr).toMatch(/interactive terminal/);
    expect(left(fx, "rounds")).toBe(0);
    expect(() => raiseBudget(new Ledger(fx.location.dir), fx.goalId, "rounds", 1, "omf")).toThrow(BudgetError);
    expect(() => resumeGoal(new Ledger(fx.location.dir), fx.goalId, "omf")).toThrow();

    // A person raises (the library call is what the confirmed CLI command runs). Raising alone does not restart the goal.
    raiseBudget(new Ledger(fx.location.dir), fx.goalId, "rounds", 1, "human:dev");
    expect(left(fx, "rounds")).toBe(1);
    expect(resultOf(tickCli(fx, ["--json"])).outcome).toBe("stopped_until_resumed");
    resumeGoal(new Ledger(fx.location.dir), fx.goalId, "human:dev");
    setReading(fx, 4300);
    expect(tickCli(fx).code).toBe(0);
    expect(modelCalls(fx)).toBe(3);
    expect(left(fx, "rounds")).toBe(0);
  });

  it("an exhausted disclosure budget stops re-seeding and charges nothing", () => {
    const fx = setupEnforcementGoal({ rounds: 5, disclosure: 1 });
    useCleanModel(fx);

    expect(tickCli(fx).code).toBe(0);
    expect(left(fx, "disclosure")).toBe(0);
    expect(left(fx, "rounds")).toBe(4);

    setReading(fx, 4100);
    const second = tickCli(fx, ["--json"]);
    expect(second.code).toBe(1);
    expect(resultOf(second).escalation).toMatchObject({ j: "J8", reason_code: "disclosure_exhausted" });
    expect(modelCalls(fx), "no second disclosure").toBe(1);
    expect(spent(fx, "rounds"), "disclosure is checked before either budget is consumed").toBe(1);
    expect(spent(fx, "disclosure")).toBe(1);

    raiseBudget(new Ledger(fx.location.dir), fx.goalId, "disclosure", 1, "human:dev");
    resumeGoal(new Ledger(fx.location.dir), fx.goalId, "human:dev");
    setReading(fx, 4200);
    expect(tickCli(fx).code).toBe(0);
    expect(modelCalls(fx)).toBe(2);
    expect(left(fx, "disclosure")).toBe(0);
    expect(left(fx, "rounds")).toBe(3);
  });
});
