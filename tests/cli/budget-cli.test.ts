import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { budgetLines, budgetReport, parseBudgetArgs, runBudgetCommand } from "../../src/cli/work.js";
import { BudgetError, budgetState, consumeBudget } from "../../src/core/budget.js";
import { Ledger } from "../../src/core/ledger.js";
import { lockGoal } from "../../src/goal/goal-lock.js";
import { omf } from "../helpers/cli.js";
import { type GoalFixture, setupGoal } from "../helpers/goal.js";
import { makeGitRepo, makeTempDir } from "../helpers/tmp.js";

const T0 = new Date("2026-01-01T00:00:00.000Z");
const HOUR = 3_600_000;
const at = (hours: number): Date => new Date(T0.getTime() + hours * HOUR);

/** An approved goal g-fast (72h wall time, 10 rounds). `when` pins the approval time for exact elapsed values. */
function approved(when?: Date): GoalFixture {
  const fx = setupGoal();
  if (when === undefined) lockGoal(fx.location, "g-fast", "human:dev");
  else lockGoal(fx.location, "g-fast", "human:dev", () => when);
  return fx;
}

const ledgerText = (fx: GoalFixture): string => readFileSync(join(fx.location.dir, "ledger.jsonl"), "utf8");
const eventsOf = (fx: GoalFixture, type: string) =>
  new Ledger(fx.location.dir).readVerified().filter((event) => event.type === type);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof BudgetError ? err.code : "not a BudgetError";
  }
  return undefined;
}

// Spec §4.4, J8: budget caps and raises are a person's decision. runBudgetCommand is the write path the
// CLI runs after the typed confirmation, so these tests need no terminal.
describe("parseBudgetArgs", () => {
  it("parses a counted budget with its amount", () => {
    expect(parseBudgetArgs({ verb: "declare", goalId: "g-fast", kind: "disclosure", amount: "3" })).toEqual({
      verb: "declare",
      goalId: "g-fast",
      kind: "disclosure",
      amount: 3,
    });
  });

  it("parses a wall time raise as a duration", () => {
    expect(parseBudgetArgs({ verb: "raise", goalId: "g-fast", kind: "wall_time", amount: "2h" })).toEqual({
      verb: "raise",
      goalId: "g-fast",
      kind: "wall_time",
      by: "2h",
    });
  });

  it("refuses to declare wall time, which comes from goal.md", () => {
    const args = { verb: "declare", goalId: "g-fast", kind: "wall_time", amount: "2h" } as const;
    expect(codeOf(() => parseBudgetArgs(args))).toBe("forbidden");
    expect(() => parseBudgetArgs(args)).toThrow("wall time is set by goal.md at J1 approval");
  });

  it("refuses an unknown kind", () => {
    expect(() => parseBudgetArgs({ verb: "raise", goalId: "g-fast", kind: "tokens", amount: "1" })).toThrow(
      "unknown budget kind tokens; use rounds, disclosure or wall_time",
    );
  });

  it("refuses amounts that are not positive integers", () => {
    for (const amount of ["0", "-1", "2.5", "abc", "1e3", ""]) {
      const args = { verb: "raise", goalId: "g-fast", kind: "rounds", amount } as const;
      expect(codeOf(() => parseBudgetArgs(args)), amount).toBe("invalid_amount");
    }
    expect(() => parseBudgetArgs({ verb: "raise", goalId: "g-fast", kind: "rounds", amount: "abc" })).toThrow(
      "amount must be a positive integer; got abc",
    );
  });

  it("refuses a wall time that is not a duration, and a malformed goal id", () => {
    for (const amount of ["2", "2x", "0h", "-2h"]) {
      expect(() => parseBudgetArgs({ verb: "raise", goalId: "g-fast", kind: "wall_time", amount }), amount).toThrow(
        /invalid duration/,
      );
    }
    expect(() => parseBudgetArgs({ verb: "raise", goalId: "fast", kind: "rounds", amount: "1" })).toThrow(
      "invalid goal id fast",
    );
  });
});

describe("runBudgetCommand", () => {
  it("declares a disclosure budget as a person", () => {
    const fx = approved();
    const message = runBudgetCommand(
      fx.location,
      { verb: "declare", goalId: "g-fast", kind: "disclosure", amount: "3" },
      "human:dev",
    );
    expect(message).toBe("declared disclosure budget 3 for g-fast as human:dev");
    expect(budgetState(new Ledger(fx.location.dir), "g-fast", "disclosure")).toEqual({
      kind: "disclosure",
      declared: 3,
      raised: 0,
      consumed: 0,
      remaining: 3,
    });
  });

  it("raises rounds and reports what is left", () => {
    const fx = approved();
    const message = runBudgetCommand(
      fx.location,
      { verb: "raise", goalId: "g-fast", kind: "rounds", amount: "5" },
      "human:dev",
    );
    expect(message).toBe("raised rounds budget of g-fast by 5 as human:dev; 15 remaining");
    expect(budgetState(new Ledger(fx.location.dir), "g-fast", "rounds")).toMatchObject({ raised: 5, remaining: 15 });
  });

  it("refuses a second declaration and a raise before any declaration", () => {
    const fx = approved();
    const declare = { verb: "declare", goalId: "g-fast", kind: "rounds", amount: "1" } as const;
    expect(codeOf(() => runBudgetCommand(fx.location, declare, "human:dev"))).toBe("already_declared");
    const raise = { verb: "raise", goalId: "g-fast", kind: "disclosure", amount: "1" } as const;
    expect(codeOf(() => runBudgetCommand(fx.location, raise, "human:dev"))).toBe("not_declared");
  });

  it("refuses omf and agents for every kind, and writes nothing", () => {
    const fx = approved();
    const before = ledgerText(fx);
    const attempts = [
      { verb: "raise", goalId: "g-fast", kind: "rounds", amount: "1" },
      { verb: "declare", goalId: "g-fast", kind: "disclosure", amount: "1" },
      { verb: "raise", goalId: "g-fast", kind: "wall_time", amount: "2h" },
    ] as const;
    for (const args of attempts) {
      for (const actor of ["omf", "agent:claude"]) {
        expect(codeOf(() => runBudgetCommand(fx.location, args, actor)), `${args.kind} ${actor}`).toBe("forbidden");
      }
    }
    expect(() =>
      runBudgetCommand(fx.location, { verb: "raise", goalId: "g-fast", kind: "rounds", amount: "1" }, "omf"),
    ).toThrow("only a person may raise a budget (J8); actor was omf");
    expect(ledgerText(fx)).toBe(before);
  });

  it("refuses a goal that does not exist", () => {
    const fx = approved();
    expect(() =>
      runBudgetCommand(fx.location, { verb: "raise", goalId: "g-nope", kind: "rounds", amount: "1" }, "human:dev"),
    ).toThrow("goal g-nope not found; run omf goal new g-nope");
  });

  it("raises wall time by a duration and records it for the audit to add", () => {
    const fx = approved(T0);
    const message = runBudgetCommand(
      fx.location,
      { verb: "raise", goalId: "g-fast", kind: "wall_time", amount: "2h" },
      "human:dev",
    );
    expect(message).toBe("raised wall time for g-fast by 2h as human:dev");
    const raised = eventsOf(fx, "goal.wall_time_raised");
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ actor: "human:dev", payload: { goal_id: "g-fast", by: "2h" } });
    expect(budgetReport(fx.location, "g-fast", at(3)).wall_time).toEqual({
      base_ms: 72 * HOUR,
      raised_ms: 2 * HOUR,
      limit_ms: 74 * HOUR,
      elapsed_ms: 3 * HOUR,
      remaining_ms: 71 * HOUR,
      exceeded: false,
    });
  });

  it("refuses to raise the wall time of a goal that was never approved, and writes nothing", () => {
    const fx = setupGoal();
    const before = ledgerText(fx);
    const args = { verb: "raise", goalId: "g-fast", kind: "wall_time", amount: "2h" } as const;
    expect(codeOf(() => runBudgetCommand(fx.location, args, "human:dev"))).toBe("not_declared");
    expect(() => runBudgetCommand(fx.location, args, "human:dev")).toThrow(
      "goal g-fast is not approved; wall time counts from the first approval",
    );
    expect(ledgerText(fx)).toBe(before);
  });
});

describe("budgetReport and budgetLines", () => {
  it("says nothing is declared or approved for a draft goal", () => {
    const fx = setupGoal();
    const report = budgetReport(fx.location, "g-fast", T0);
    expect(report).toEqual({
      goal_id: "g-fast",
      rounds: null,
      disclosure: null,
      wall_time: null,
      wall_time_note: "not approved yet; wall time counts from the first approval",
    });
    expect(budgetLines(report)).toEqual([
      "budget for g-fast",
      "rounds: not declared",
      "disclosure: not declared",
      "wall time: not approved yet; wall time counts from the first approval",
    ]);
  });

  it("lists declared, raised, consumed and remaining, and the wall time clock", () => {
    const fx = approved(T0);
    runBudgetCommand(fx.location, { verb: "raise", goalId: "g-fast", kind: "rounds", amount: "5" }, "human:dev");
    runBudgetCommand(fx.location, { verb: "declare", goalId: "g-fast", kind: "disclosure", amount: "3" }, "human:dev");
    consumeBudget(new Ledger(fx.location.dir), "g-fast", "rounds");
    expect(budgetLines(budgetReport(fx.location, "g-fast", at(1.5)))).toEqual([
      "budget for g-fast",
      "rounds: declared 10, raised 5, consumed 1, remaining 14",
      "disclosure: declared 3, raised 0, consumed 0, remaining 3",
      "wall time: base 72h, raised 0m, limit 72h, elapsed 1h 30m, remaining 70h 30m",
    ]);
  });

  it("marks wall time that ran out, with a negative remainder", () => {
    const fx = approved(T0);
    const report = budgetReport(fx.location, "g-fast", at(80));
    expect(report.wall_time).toMatchObject({ remaining_ms: -8 * HOUR, exceeded: true });
    expect(budgetLines(report)[3]).toBe(
      "wall time: base 72h, raised 0m, limit 72h, elapsed 80h, remaining -8h (exceeded)",
    );
  });

  it("refuses a goal that does not exist", () => {
    const fx = setupGoal();
    expect(() => budgetReport(fx.location, "g-nope")).toThrow("goal g-nope not found");
  });
});

describe("omf budget (CLI)", () => {
  it("lists its subcommands", () => {
    const out = omf(["budget", "--help"], makeGitRepo(), makeTempDir("omf-home-"));
    expect(out.code).toBe(0);
    for (const verb of ["show", "declare", "raise"]) expect(out.stdout).toContain(verb);
  });

  it("show prints rounds, disclosure and wall time", () => {
    const fx = approved();
    const result = omf(["budget", "show", "g-fast"], fx.repo, fx.home);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("budget for g-fast");
    expect(result.stdout).toContain("rounds: declared 10, raised 0, consumed 0, remaining 10");
    expect(result.stdout).toContain("disclosure: not declared");
    // Real clock: a few seconds have passed since the approval, and minutes are floored, so 72h left reads 71h 59m.
    expect(result.stdout).toMatch(/wall time: base 72h, raised 0m, limit 72h, elapsed [0-9]m, remaining 71h [0-9]+m/);
  });

  it("show lists what was raised", () => {
    const fx = approved();
    runBudgetCommand(fx.location, { verb: "raise", goalId: "g-fast", kind: "rounds", amount: "5" }, "human:dev");
    runBudgetCommand(fx.location, { verb: "raise", goalId: "g-fast", kind: "wall_time", amount: "2h" }, "human:dev");
    const result = omf(["budget", "show", "g-fast"], fx.repo, fx.home);
    expect(result.stdout).toContain("rounds: declared 10, raised 5, consumed 0, remaining 15");
    expect(result.stdout).toContain("wall time: base 72h, raised 2h, limit 74h");
  });

  it("show --json has one object with the three budgets", () => {
    const fx = approved();
    const report = JSON.parse(omf(["budget", "show", "g-fast", "--json"], fx.repo, fx.home).stdout) as unknown;
    expect(report).toMatchObject({
      goal_id: "g-fast",
      rounds: { kind: "rounds", declared: 10, raised: 0, consumed: 0, remaining: 10 },
      disclosure: null,
      wall_time: { base_ms: 72 * HOUR, raised_ms: 0, limit_ms: 72 * HOUR, exceeded: false },
      wall_time_note: null,
    });
  });

  it("show works for a draft goal and exits 2 for an unknown one", () => {
    const fx = setupGoal();
    const draft = omf(["budget", "show", "g-fast"], fx.repo, fx.home);
    expect(draft.code).toBe(0);
    expect(draft.stdout).toContain("rounds: not declared");
    expect(draft.stdout).toContain("wall time: not approved yet");
    const unknown = omf(["budget", "show", "g-nope"], fx.repo, fx.home);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("goal g-nope not found");
  });

  it("needs an initialized project", () => {
    const result = omf(["budget", "show", "g-fast"], makeGitRepo(), makeTempDir("omf-home-"));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("project not initialized; run omf init");
  });

  it("declare and raise refuse without a terminal and write nothing", () => {
    const fx = approved();
    const before = ledgerText(fx);
    const attempts = [
      ["budget", "declare", "g-fast", "disclosure", "3"],
      ["budget", "raise", "g-fast", "rounds", "2"],
      ["budget", "raise", "g-fast", "wall_time", "2h"],
    ];
    for (const args of attempts) {
      const result = omf(args, fx.repo, fx.home);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.stderr, args.join(" ")).toContain(
        `J8 budget ${args[1]} needs an interactive terminal; nothing was done`,
      );
      expect(ledgerText(fx), args.join(" ")).toBe(before);
    }
  });

  it("reports a usage error before it asks for a terminal", () => {
    const fx = approved();
    const cases: [string[], string][] = [
      [["budget", "declare", "g-fast", "wall_time", "2h"], "wall time is set by goal.md at J1 approval"],
      [["budget", "raise", "g-fast", "rounds", "abc"], "amount must be a positive integer; got abc"],
      [["budget", "raise", "g-fast", "tokens", "1"], "unknown budget kind tokens"],
      [["budget", "raise", "g-fast", "wall_time", "2"], "invalid duration 2"],
    ];
    for (const [args, message] of cases) {
      const result = omf(args, fx.repo, fx.home);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.stderr, args.join(" ")).toContain(message);
      expect(result.stderr, args.join(" ")).not.toContain("interactive terminal");
    }
  });
});
