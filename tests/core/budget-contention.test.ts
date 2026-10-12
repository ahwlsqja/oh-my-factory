import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { budgetState, declareBudget } from "../../src/core/budget.js";
import { Ledger } from "../../src/core/ledger.js";
import { makeTempDir } from "../helpers/tmp.js";

const BUDGET_MODULE = resolve("dist/core/budget.js");
const LEDGER_MODULE = resolve("dist/core/ledger.js");

/** Child: tries to consume the single remaining round. Exit 0 = consumed, 3 = refused by budget rules. */
const CHILD = `
const { consumeBudget, BudgetError } = await import(process.argv[1]);
const { Ledger } = await import(process.argv[2]);
const dir = process.argv[3];
try {
  consumeBudget(new Ledger(dir), "g-race");
  process.exit(0);
} catch (err) {
  process.exit(err instanceof BudgetError ? 3 : 1);
}
`;

function runChild(dir: string): Promise<number> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD, BUDGET_MODULE, LEDGER_MODULE, dir], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.on("error", fail);
    child.on("exit", (code) => done(code ?? -1));
  });
}

describe("budget consumption across processes", () => {
  it("consumes the last round exactly once when processes race", async () => {
    const dir = makeTempDir("omf-budget-race-");
    declareBudget(new Ledger(dir), "g-race", 1, "human:dev");
    const codes = await Promise.all([1, 2, 3, 4].map(() => runChild(dir)));
    expect(codes.sort()).toEqual([0, 3, 3, 3]);
    expect(budgetState(new Ledger(dir), "g-race")).toMatchObject({ remaining: 0, consumed: 1 });
  });
});
