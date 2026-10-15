import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createMarkdownStore } from "../../src/adapters/state-markdown.js";
import {
  type BudgetRaiseArgs,
  type ParsedBudgetRaise,
  parseBudgetRaiseArgs,
  workLimitLines,
  workLimitRaiseFlow,
} from "../../src/cli/work.js";
import { foldWorkBudget } from "../../src/work/w-budget.js";
import { omf } from "../helpers/cli.js";
import { type GoalFixture, setupGoal } from "../helpers/goal.js";
import { gitIn } from "../helpers/tmp.js";
import { HIGH_RISK, createRecorded, makeNewItem } from "../helpers/work.js";

const ACTOR = "human:dev@example.com";
const RUN = "r-20261012T100000Z-ab12";
const TTY = { stdin: { isTTY: true }, stdout: { isTTY: true } };

/** A goal with item `workId` that already has its limits recorded (3 rounds, 5 USD), as after a first run. */
function setup(): { fx: GoalFixture; workId: string; store: ReturnType<typeof createMarkdownStore> } {
  const fx = setupGoal();
  gitIn(fx.repo, "config", "user.email", "dev@example.com");
  const store = createMarkdownStore(fx.location.dir);
  const item = createRecorded(fx.ledger, store, makeNewItem());
  fx.ledger.append({
    actor: "omf",
    type: "work.limits_set",
    payload: { goal_id: item.front.goal_id, work_id: item.front.work_id, run_id: RUN, max_rounds: 3, max_model_micro_usd: 5_000_000 },
  });
  return { fx, workId: item.front.work_id, store };
}

const ledgerText = (fx: GoalFixture): string => readFileSync(join(fx.location.dir, "ledger.jsonl"), "utf8");
const budgetOf = (fx: GoalFixture, workId: string) => foldWorkBudget(fx.ledger.readVerified(), workId);

function fakeTerminal(): { io: { input: PassThrough; output: PassThrough }; shown: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = "";
  output.on("data", (chunk: Buffer) => {
    shown += chunk.toString("utf8");
  });
  return { io: { input, output }, shown: () => shown };
}

function workRaise(raw: BudgetRaiseArgs): Extract<ParsedBudgetRaise, { form: "work" }> {
  const parsed = parseBudgetRaiseArgs(raw);
  if (parsed.form !== "work") throw new Error("expected the work form");
  return parsed;
}

const WID = "w-0123456789ab";

describe("parseBudgetRaiseArgs", () => {
  it("keeps the goal form: <goal_id> <kind> <amount>", () => {
    expect(parseBudgetRaiseArgs({ id: "g-fast", kind: "rounds", amount: "2" })).toEqual({
      form: "goal",
      args: { verb: "raise", goalId: "g-fast", kind: "rounds", amount: "2" },
    });
  });

  it("parses --rounds and --usd for a work id into the units the ledger stores", () => {
    expect(parseBudgetRaiseArgs({ id: WID, rounds: "2" })).toEqual({ form: "work", workId: WID, kind: "rounds", amount: 2, display: "2" });
    expect(parseBudgetRaiseArgs({ id: WID, usd: "0.1" })).toEqual({
      form: "work",
      workId: WID,
      kind: "model_micro_usd",
      amount: 100_000,
      display: "0.1 USD",
    });
  });

  it.each<[string, BudgetRaiseArgs, string]>([
    ["a work id alone", { id: WID }, "give exactly one of --rounds <n> and --usd <amount>"],
    ["both options", { id: WID, rounds: "1", usd: "1" }, "give exactly one of --rounds <n> and --usd <amount>"],
    ["--rounds 0", { id: WID, rounds: "0" }, "--rounds must be a positive integer"],
    ["--rounds 1.5", { id: WID, rounds: "1.5" }, "--rounds must be a positive integer"],
    ["--usd 0", { id: WID, usd: "0" }, "--usd must be a positive amount of dollars"],
    ["--usd -1", { id: WID, usd: "-1" }, "--usd must be a positive amount of dollars"],
    ["--usd abc", { id: WID, usd: "abc" }, "--usd must be a positive amount of dollars"],
    ["--usd 1e3", { id: WID, usd: "1e3" }, "--usd must be a positive amount of dollars"],
    ["a work id with <kind> <amount>", { id: WID, kind: "rounds", amount: "2" }, "a work item takes --rounds or --usd"],
    ["a goal id with --rounds", { id: "g-fast", rounds: "2" }, "is not a work id"],
    ["a goal id alone", { id: "g-fast" }, "needs <kind> <amount>"],
  ])("refuses %s", (_label, raw, message) => {
    expect(() => parseBudgetRaiseArgs(raw)).toThrow(message);
  });
});

describe("omf budget raise <work_id> (CLI)", () => {
  it("needs an interactive terminal: piped stdin exits 2 and writes nothing", () => {
    const { fx, workId } = setup();
    const before = ledgerText(fx);
    const result = omf(["budget", "raise", workId, "--rounds", "2"], fx.repo, fx.home);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("needs an interactive terminal");
    expect(ledgerText(fx)).toBe(before);
  });

  it.each<[string[], string]>([
    [[], "give exactly one of --rounds <n> and --usd <amount>"],
    [["--rounds", "1", "--usd", "1"], "give exactly one of --rounds <n> and --usd <amount>"],
    [["--rounds", "0"], "--rounds must be a positive integer"],
    [["--usd", "0"], "--usd must be a positive amount of dollars"],
    [["--usd=-1"], "--usd must be a positive amount of dollars"],
    [["--usd", "abc"], "--usd must be a positive amount of dollars"],
  ])("exits 2 with a usage error for %j, with or without a terminal, and writes nothing", (args, message) => {
    const { fx, workId } = setup();
    const before = ledgerText(fx);
    const result = omf(["budget", "raise", workId, ...args], fx.repo, fx.home);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
    expect(ledgerText(fx)).toBe(before);
  });

  // A deliberate change to the goal form: <kind> and <amount> were required arguments, so a missing one was commander's
  // usage error (exit 1). They are optional now (the work form takes none), so the same mistake is the parse error of
  // `parseBudgetRaiseArgs` and exits 2 like every other usage error of this command. Pinned here so it is not silent.
  it("exits 2, not commander's 1, when the goal form lacks its <kind> <amount>", () => {
    const { fx } = setup();
    const before = ledgerText(fx);
    const result = omf(["budget", "raise", "g-fast"], fx.repo, fx.home);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("needs <kind> <amount>");
    expect(ledgerText(fx)).toBe(before);
  });
});

describe("workLimitRaiseFlow", () => {
  it("shows the limits in force, and a typed confirmation appends one human work.limit_raised", async () => {
    const { fx, workId } = setup();
    const term = fakeTerminal();
    const lines: string[] = [];
    const flow = workLimitRaiseFlow(fx.location, workRaise({ id: workId, rounds: "2" }), ACTOR, term.io, TTY, (line) => lines.push(line));
    term.io.input.write(`${workId}\n`);
    await expect(flow).resolves.toBe(0);

    const raised = fx.ledger.readVerified().filter((event) => event.type === "work.limit_raised");
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ actor: ACTOR, payload: { work_id: workId, kind: "rounds", amount: 2 } });
    expect(budgetOf(fx, workId).effective).toEqual({ max_rounds: 5, max_model_micro_usd: 5_000_000 });

    // What was printed above the prompt is the limit before the raise; after it the same lines show the new one.
    expect(lines).toContain("rounds: limit 3 (raised 0), started 0");
    expect(workLimitLines(fx.location, workId)).toContain("rounds: limit 5 (raised 2), started 0");
    expect(lines.join("\n")).toContain("raised");
    // Ids and numbers only: nothing from the item's text reaches the screen.
    expect(`${lines.join("\n")}${term.shown()}`).not.toContain("Cache the render path");
  });

  it("raises model spend in micro-USD from --usd", async () => {
    const { fx, workId } = setup();
    const term = fakeTerminal();
    const flow = workLimitRaiseFlow(fx.location, workRaise({ id: workId, usd: "0.25" }), ACTOR, term.io, TTY, () => undefined);
    term.io.input.write(`${workId}\n`);
    await expect(flow).resolves.toBe(0);
    expect(budgetOf(fx, workId).raised).toEqual({ rounds: 0, model_micro_usd: 250_000 });
    expect(workLimitLines(fx.location, workId)).toContain("model spend: limit 5.250000 USD (raised 0.250000), spent 0.000000 USD");
  });

  it("returns 1 and writes nothing when the person does not retype the id", async () => {
    const { fx, workId } = setup();
    const before = ledgerText(fx);
    const term = fakeTerminal();
    const flow = workLimitRaiseFlow(fx.location, workRaise({ id: workId, rounds: "2" }), ACTOR, term.io, TTY, () => undefined);
    term.io.input.write("no\n");
    await expect(flow).resolves.toBe(1);
    expect(ledgerText(fx)).toBe(before);
  });

  it("refuses without a terminal, before it prints anything", async () => {
    const { fx, workId } = setup();
    const before = ledgerText(fx);
    const term = fakeTerminal();
    await expect(
      workLimitRaiseFlow(fx.location, workRaise({ id: workId, rounds: "2" }), ACTOR, term.io, { stdin: {}, stdout: {} }, () => undefined),
    ).rejects.toThrow("needs an interactive terminal");
    expect(ledgerText(fx)).toBe(before);
    expect(term.shown()).toBe("");
  });

  it("refuses an item without limits and an item that is not open, with no prompt and nothing written", async () => {
    const { fx, store } = setup();
    const noLimits = createRecorded(fx.ledger, store, makeNewItem({ title: "Trim the cache keys" })).front.work_id;
    const gated = createRecorded(fx.ledger, store, makeNewItem({ title: "Update the CI workflow", risk: HIGH_RISK })).front.work_id;
    const before = ledgerText(fx);
    for (const [workId, code] of [[noLimits, "no_limits"], [gated, "wrong_state"]] as const) {
      const term = fakeTerminal();
      await expect(
        workLimitRaiseFlow(fx.location, workRaise({ id: workId, rounds: "1" }), ACTOR, term.io, TTY, () => undefined),
      ).rejects.toMatchObject({ code });
      expect(term.shown(), code).toBe("");
    }
    expect(ledgerText(fx)).toBe(before);
  });
});
