import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createMarkdownStore } from "../../src/adapters/state-markdown.js";
import { confirmByTyping } from "../../src/cli/confirm.js";
import * as decide from "../../src/cli/decide.js";
import { runDecideDefer, runDecideNa, runDecideResolve } from "../../src/cli/decide.js";
import {
  type ConfirmFn,
  type SignAction,
  confirmSign,
  decisionScreen,
  signRetype,
} from "../../src/cli/decide-sign.js";
import { lockGoal } from "../../src/goal/goal-lock.js";
import { specFile } from "../../src/decision/spec-md.js";
import { findDecision, foldDecisions } from "../../src/decision/state.js";
import type { DeferInput, InterfaceContract, NaInput, ResolveInput } from "../../src/decision/types.js";
import { DecisionError } from "../../src/decision/write.js";
import type { WorkItem } from "../../src/work/types.js";
import { type GoalFixture, setupGoal } from "../helpers/goal.js";
import { createRecorded, makeNewItem } from "../helpers/work.js";
import { omf } from "../helpers/cli.js";
import { makeTempDir } from "../helpers/tmp.js";
import { needsHumanFile } from "../../src/decision/needs-human.js";

const NOW = new Date("2026-10-14T09:00:00.000Z");

const RESOLVE: ResolveInput = {
  choice: "Key the cache by the normalized input only.",
  rationale: "Callers differ in options that do not change the output.",
  rejected: ["Key by the full request."],
};
const DEFER: DeferInput = {
  owner: "release owner",
  reason: "Needs real traffic first.",
  revisit_trigger: "After the first week in production.",
  default: "Use an unbounded cache until then.",
  expires_at: "2099-01-01T00:00:00.000Z",
};
const NA: NaInput = { rationale: "The cache is removed in this change." };
const CONTRACT: InterfaceContract = {
  kind: "cli",
  build: ["npm", "run", "build"],
  run: ["node", "dist/cli/main.js"],
  io_contract: "Reads a file path and prints the rendered page.",
  gates: { fast: ["npm", "run", "typecheck"], full: ["npm", "test"], deep: null, required: ["fast", "full"] },
  test_command: ["npm", "test"],
};

const scopeOf = (item: WorkItem) => ({ goal_id: item.front.goal_id, work_id: item.front.work_id });

/** A locked goal g-fast and one ready work item per title; OMF has added the open decision d-cache-key to each. */
function setup(titles: string[] = ["Cache the render path"]): { fx: GoalFixture; items: WorkItem[] } {
  const fx = setupGoal();
  lockGoal(fx.location, "g-fast", "human:dev");
  const store = createMarkdownStore(fx.location.dir);
  const items = titles.map((title) => createRecorded(fx.ledger, store, makeNewItem({ title })));
  for (const item of items) {
    decide.runDecideAdd(
      fx.location,
      item.front.work_id,
      { id: "d-cache-key", class: "other", question: "Which key identifies a cached render?" },
      "omf",
      NOW,
    );
  }
  return { fx, items };
}

function recordOf(fx: GoalFixture, item: WorkItem, id: string) {
  const record = findDecision(foldDecisions(fx.ledger.readVerified(), scopeOf(item)), id);
  if (record === null) throw new Error(`fixture lacks ${id}`);
  return record;
}

/** A confirm that answers by typing `line` into a fake terminal, through the real confirmByTyping. */
function typed(line: string, seen: { expected?: string; prompt?: string } = {}): ConfirmFn {
  return (expected, prompt) => {
    seen.expected = expected;
    seen.prompt = prompt;
    const input = new PassThrough();
    const answer = confirmByTyping(expected, prompt, { input, output: new PassThrough() });
    input.write(`${line}\n`);
    return answer;
  };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof DecisionError ? err.code : "not a DecisionError";
  }
  return undefined;
}

// Spec §6.2: a person signs a decision knowing which work item it belongs to and what will be recorded.
describe("decisionScreen", () => {
  it("names the work item and shows the choice a resolution would record", () => {
    const { fx, items } = setup(["Cache the render path"]);
    const item = items[0]!;
    const lines = decisionScreen(item, recordOf(fx, item, "d-cache-key"), { verb: "resolve", input: RESOLVE });
    const text = lines.join("\n");
    expect(text).toContain(`work ${item.front.work_id} of goal g-fast: Cache the render path`);
    expect(text).toContain("decision d-cache-key (class other): Which key identifies a cached render?");
    expect(text).toContain("choice: Key the cache by the normalized input only.");
    expect(text).toContain("rejected: Key by the full request.");
  });

  it("shows the interface body and the response measure that are being signed", () => {
    const { fx, items } = setup();
    const item = items[0]!;
    const workId = item.front.work_id;
    decide.runDecideAdd(
      fx.location,
      workId,
      { id: "d-interface", class: "interface", question: "How is the product built, run and checked?" },
      "omf",
      NOW,
    );
    decide.runDecideAdd(
      fx.location,
      workId,
      {
        id: "d-render-latency",
        class: "latency",
        question: "How fast must a render finish?",
        response_measure: { metric: "render time", op: "<=", threshold: 80, unit: "ms", percentile: 95, window: null },
      },
      "omf",
      NOW,
    );
    const iface = decisionScreen(item, recordOf(fx, item, "d-interface"), {
      verb: "resolve",
      input: { choice: "A command line tool.", rationale: "It is what the users run.", interface: CONTRACT },
    }).join("\n");
    expect(iface).toContain('build: ["npm","run","build"]');
    expect(iface).toContain('run: ["node","dist/cli/main.js"]');
    expect(iface).toContain("gate deep: none");
    expect(iface).toContain("required gates: fast, full");
    expect(iface).toContain('test command: ["npm","test"]');
    const latency = decisionScreen(item, recordOf(fx, item, "d-render-latency"), {
      verb: "resolve",
      input: { choice: "Budget the render step.", rationale: "It is on the first answer." },
    }).join("\n");
    expect(latency).toContain("measure: render time <= 80 ms at p95");
  });

  it("shows what a deferral or a not-applicable note would record", () => {
    const { fx, items } = setup();
    const item = items[0]!;
    const record = recordOf(fx, item, "d-cache-key");
    const deferred = decisionScreen(item, record, { verb: "defer", input: DEFER }).join("\n");
    expect(deferred).toContain("owner: release owner");
    expect(deferred).toContain("default: Use an unbounded cache until then.");
    expect(deferred).toContain("expires: 2099-01-01T00:00:00.000Z");
    expect(decisionScreen(item, record, { verb: "na", input: NA }).join("\n")).toContain(
      "rationale: The cache is removed in this change.",
    );
  });
});

describe("confirmSign", () => {
  const action: SignAction = { verb: "resolve", input: RESOLVE };

  it("asks for <work_id>/<decision_id> and confirms only that text", async () => {
    const { fx, items } = setup();
    const item = items[0]!;
    const record = recordOf(fx, item, "d-cache-key");
    const workId = item.front.work_id;
    const seen: { expected?: string; prompt?: string } = {};
    expect(await confirmSign(item, record, action, "human:dev", typed(`${workId}/d-cache-key`, seen))).toBe(true);
    expect(seen.expected).toBe(`${workId}/d-cache-key`);
    expect(seen.prompt).toBe(`Type ${workId}/d-cache-key to resolve as human:dev: `);
    // Retyping only the decision id, as the budget and goal commands retype their id, is a decline.
    expect(await confirmSign(item, record, action, "human:dev", typed("d-cache-key"))).toBe(false);
  });

  it("makes the same decision id in two work items need two different retypes", async () => {
    const { fx, items } = setup(["Cache the render path", "Defer the report export"]);
    const first = items[0]!;
    const second = items[1]!;
    expect(signRetype(first.front.work_id, "d-cache-key")).not.toBe(signRetype(second.front.work_id, "d-cache-key"));
    const record = recordOf(fx, second, "d-cache-key");
    const other = signRetype(first.front.work_id, "d-cache-key");
    expect(await confirmSign(second, record, action, "human:dev", typed(other))).toBe(false);
    expect(await confirmSign(second, record, action, "human:dev", typed(signRetype(second.front.work_id, "d-cache-key")))).toBe(true);
  });
});

// The write cores are T9's (src/cli/decide.ts); here they are exercised with a person as the actor.
describe("runDecideResolve, runDecideDefer and runDecideNa", () => {
  it("records a person's resolution and re-renders spec.md; a non-human actor writes nothing", () => {
    const { fx, items } = setup();
    const item = items[0]!;
    const workId = item.front.work_id;
    const before = readFileSync(specFile(item.dir), "utf8");
    const ledgerBefore = fx.ledger.readVerified().length;
    expect(codeOf(() => runDecideResolve(fx.location, workId, "d-cache-key", RESOLVE, "agent:x", NOW))).toBe("not_human");
    expect(fx.ledger.readVerified()).toHaveLength(ledgerBefore);
    expect(readFileSync(specFile(item.dir), "utf8")).toBe(before);

    const { event } = runDecideResolve(fx.location, workId, "d-cache-key", RESOLVE, "human:dev", NOW);
    expect(event).toMatchObject({
      type: "decision.resolved",
      actor: "human:dev",
      payload: { decision_id: "d-cache-key", resolution: { choice: RESOLVE.choice, by: "human:dev" } },
    });
    const after = readFileSync(specFile(item.dir), "utf8");
    expect(after).not.toBe(before);
    expect(after).toContain(RESOLVE.choice);
  });

  it("records a deferral signed by the actor and a not-applicable note, each in spec.md", () => {
    const { fx, items } = setup(["Cache the render path", "Defer the report export"]);
    const [deferItem, naItem] = [items[0]!, items[1]!];
    const deferred = runDecideDefer(fx.location, deferItem.front.work_id, "d-cache-key", DEFER, "human:dev", NOW);
    expect(deferred.event).toMatchObject({
      type: "decision.deferred",
      payload: { decision_id: "d-cache-key", deferral: { signed_by: "human:dev", expires_at: DEFER.expires_at } },
    });
    expect(readFileSync(specFile(deferItem.dir), "utf8")).toContain(DEFER.default);
    const na = runDecideNa(fx.location, naItem.front.work_id, "d-cache-key", NA, "human:dev", NOW);
    expect(na.event).toMatchObject({ type: "decision.marked_na", payload: { decision_id: "d-cache-key" } });
    expect(readFileSync(specFile(naItem.dir), "utf8")).toContain(NA.rationale);
  });
});

// The built CLI has no terminal in a test: stdin and stdout are pipes, which is exactly the case that must
// refuse (spec §6.2). The interactive path is covered above through decisionScreen, confirmSign and run*.
describe("omf decide resolve|defer on the built CLI", () => {
  const rawFile = (text: string): string => {
    const file = join(makeTempDir("omf-decision-"), "input.json");
    writeFileSync(file, text);
    return file;
  };
  const bodyFile = (body: unknown): string => rawFile(JSON.stringify(body));
  const ledgerText = (fx: GoalFixture): string => readFileSync(join(fx.location.dir, "ledger.jsonl"), "utf8");

  const signing: { name: string; verb: string; flags: string[]; body: unknown; refusal: string }[] = [
    {
      name: "resolve",
      verb: "resolve",
      flags: [],
      body: RESOLVE,
      refusal: "decision resolve needs an interactive terminal; nothing was resolved",
    },
    {
      name: "resolve --na",
      verb: "resolve",
      flags: ["--na"],
      body: NA,
      refusal: "decision n/a needs an interactive terminal; nothing was marked n/a",
    },
    {
      name: "defer",
      verb: "defer",
      flags: [],
      body: DEFER,
      refusal: "decision defer needs an interactive terminal; nothing was deferred",
    },
  ];

  it.each(signing)("$name refuses without a terminal and changes nothing", ({ verb, flags, body, refusal }) => {
    const { fx, items } = setup();
    const item = items[0]!;
    const ledgerBefore = ledgerText(fx);
    const specBefore = readFileSync(specFile(item.dir), "utf8");
    const out = omf(["decide", verb, item.front.work_id, "d-cache-key", "--file", bodyFile(body), ...flags], fx.repo, fx.home);
    expect(out.code, out.stderr).toBe(2);
    expect(out.stderr).toContain(refusal);
    expect(ledgerText(fx)).toBe(ledgerBefore);
    expect(readFileSync(specFile(item.dir), "utf8")).toBe(specBefore);
    expect(existsSync(needsHumanFile(item.dir))).toBe(false);
  });

  it.each([
    { name: "a file that does not exist", file: () => join(makeTempDir("omf-decision-"), "none.json"), id: "d-cache-key", message: "cannot read" },
    { name: "a file that is not JSON", file: () => rawFile("{"), id: "d-cache-key", message: "is not valid JSON" },
    { name: "a file of the wrong shape", file: () => bodyFile({ choice: "only" }), id: "d-cache-key", message: "is not a valid resolution" },
    { name: "a decision that does not exist", file: () => bodyFile(RESOLVE), id: "d-nope", message: "decision d-nope not found" },
  ])("reports $name as a usage error (exit 1), before the terminal check", ({ file, id, message }) => {
    const { fx, items } = setup();
    const out = omf(["decide", "resolve", items[0]!.front.work_id, id, "--file", file()], fx.repo, fx.home);
    expect(out.code, out.stderr).toBe(1);
    expect(out.stderr).toContain(message);
    expect(out.stderr).not.toContain("interactive terminal");
  });

  it("refuses an already closed decision before asking anyone", () => {
    const { fx, items } = setup();
    const item = items[0]!;
    runDecideResolve(fx.location, item.front.work_id, "d-cache-key", RESOLVE, "human:dev", NOW);
    const out = omf(["decide", "resolve", item.front.work_id, "d-cache-key", "--file", bodyFile(RESOLVE)], fx.repo, fx.home);
    expect(out.code, out.stderr).toBe(1);
    expect(out.stderr).toContain("decision d-cache-key is already resolved");
  });

  it("does not refuse a deferred decision: it gets as far as the terminal check (A21)", () => {
    const { fx, items } = setup();
    const item = items[0]!;
    runDecideDefer(fx.location, item.front.work_id, "d-cache-key", DEFER, "human:dev", NOW);
    const out = omf(["decide", "resolve", item.front.work_id, "d-cache-key", "--file", bodyFile(RESOLVE)], fx.repo, fx.home);
    expect(out.code, out.stderr).toBe(2);
    expect(out.stderr).toContain("interactive terminal");
    expect(out.stderr).not.toContain("already");
  });
});
