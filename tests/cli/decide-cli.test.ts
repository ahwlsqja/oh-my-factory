import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMarkdownStore } from "../../src/adapters/state-markdown.js";
import { decideReport, requireDecidableItem, runDecideAdd, runDecideResolve } from "../../src/cli/decide.js";
import { runVeto } from "../../src/cli/work.js";
import { Ledger } from "../../src/core/ledger.js";
import { loadLeakContext } from "../../src/decision/leak-lint.js";
import { renderSpec, specFile } from "../../src/decision/spec-md.js";
import { foldDecisions } from "../../src/decision/state.js";
import type { AddInput, InterfaceContract, ResolveInput } from "../../src/decision/types.js";
import { DecisionError } from "../../src/decision/write.js";
import { claimItem, releaseItem } from "../../src/work/claim.js";
import { setupTickGoal } from "../helpers/goal.js";
import { HIGH_RISK, createRecorded, makeNewItem, rewriteItem } from "../helpers/work.js";

const NOW = new Date("2026-10-12T12:00:00.000Z");
const PERSON = "human:dev@example.com";

// No digit and no metric name of the fixture goal (m-p95, target 250), so none of this text can leak.
const INTERFACE: InterfaceContract = {
  kind: "cli",
  build: ["npm", "run", "build"],
  run: ["node", "dist/main.js"],
  io_contract: "Prints one line per result and exits zero.",
  gates: { fast: ["npm", "test"], full: null, deep: null, required: ["fast"] },
  test_command: ["npm", "test"],
};
const ADD_INTERFACE: AddInput = { id: "d-interface", class: "interface", question: "How is the tool built and run?" };
const RESOLVE_INTERFACE: ResolveInput = {
  choice: "A command line tool",
  rationale: "People run it from a shell.",
  rejected: [],
  interface: INTERFACE,
};

/** An approved goal g-fast (so the leak context loads) with one ready work item. */
function fixture() {
  const fx = setupTickGoal();
  const store = createMarkdownStore(fx.location.dir);
  const item = createRecorded(fx.ledger, store, makeNewItem());
  return { ...fx, store, item, id: item.front.work_id };
}

describe("requireDecidableItem", () => {
  it("returns a ready, ledger-consistent item", () => {
    const fx = fixture();
    expect(requireDecidableItem(fx.location, fx.id).front.work_id).toBe(fx.id);
  });

  it("refuses unknown, unapproved, hand-edited, in-progress, terminal and claimed items", () => {
    const fx = fixture();
    expect(() => requireDecidableItem(fx.location, "w-ffffffffffff")).toThrow("unknown work item w-ffffffffffff");

    const gated = createRecorded(fx.ledger, fx.store, makeNewItem({ title: "Update the CI workflow", risk: HIGH_RISK }));
    expect(() => requireDecidableItem(fx.location, gated.front.work_id)).toThrow("is awaiting_approval");
    rewriteItem(gated, { state: "ready" }); // looks approved, the ledger never saw it
    expect(() => requireDecidableItem(fx.location, gated.front.work_id)).toThrow("approval_unrecorded");

    const busy = createRecorded(fx.ledger, fx.store, makeNewItem({ title: "Warm the cache" }));
    rewriteItem(busy, { state: "in_progress" }); // nothing in M3a can start an item, so this was hand-edited
    expect(() => requireDecidableItem(fx.location, busy.front.work_id)).toThrow("is in_progress");

    const gone = createRecorded(fx.ledger, fx.store, makeNewItem({ title: "Trim the logs" }));
    runVeto(fx.location, gone.front.work_id, PERSON, "not needed");
    expect(() => requireDecidableItem(fx.location, gone.front.work_id)).toThrow("is vetoed");

    claimItem(fx.item.dir); // this process is alive, so the claim is held
    try {
      expect(() => requireDecidableItem(fx.location, fx.id)).toThrow("claimed by a run");
    } finally {
      releaseItem(fx.item.dir);
    }
  });

  it("decideReport, unlike the guard, reads an in-progress item and writes nothing", () => {
    const fx = fixture();
    rewriteItem(fx.item, { state: "in_progress" });
    const before = new Ledger(fx.location.dir).readVerified().length;
    expect(decideReport(fx.location, fx.id, NOW).gate.status).toBe("blocked_on_user");
    expect(new Ledger(fx.location.dir).readVerified()).toHaveLength(before);
    expect(existsSync(specFile(fx.item.dir))).toBe(false);
  });
});

describe("the run* write cores", () => {
  it("add records the question and projects spec.md from the ledger", () => {
    const fx = fixture();
    const { event } = runDecideAdd(fx.location, fx.id, ADD_INTERFACE, "omf", NOW);
    expect(event).toMatchObject({
      type: "decision.added",
      actor: "omf",
      payload: { goal_id: "g-fast", work_id: fx.id, decision_id: "d-interface" },
    });
    const events = new Ledger(fx.location.dir).readVerified();
    const state = foldDecisions(events, { goal_id: "g-fast", work_id: fx.id });
    const leak = loadLeakContext(fx.location.dir, "g-fast", events);
    expect(readFileSync(specFile(fx.item.dir), "utf8")).toBe(renderSpec(state, { title: fx.item.front.title }, leak));
  });

  it("a refused write throws DecisionError and leaves the ledger as it was", () => {
    const fx = fixture();
    runDecideAdd(fx.location, fx.id, ADD_INTERFACE, "omf", NOW);
    const before = new Ledger(fx.location.dir).readVerified().length;
    expect(() => runDecideAdd(fx.location, fx.id, ADD_INTERFACE, "omf", NOW)).toThrow(DecisionError);
    expect(new Ledger(fx.location.dir).readVerified()).toHaveLength(before);
  });

  it("a person's resolution makes GATE-1 pass and the report clean", () => {
    const fx = fixture();
    runDecideAdd(fx.location, fx.id, ADD_INTERFACE, "omf", NOW);
    expect(decideReport(fx.location, fx.id, NOW).gate.status).toBe("blocked_on_user");
    runDecideResolve(fx.location, fx.id, "d-interface", RESOLVE_INTERFACE, PERSON, NOW);
    const report = decideReport(fx.location, fx.id, NOW);
    expect(report.gate).toEqual({ status: "pass" });
    expect(report.problems).toEqual([]);
    expect(report.spec).toBe("ok");
  });
});
