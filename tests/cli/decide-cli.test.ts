import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { HIGH_RISK, createRecorded, makeNewItem, recordW, rewriteItem } from "../helpers/work.js";
import { projectDir } from "../../src/core/paths.js";
import { goalLockFile } from "../../src/goal/goal-lock.js";
import { needsHumanFile, readNeedsHuman } from "../../src/decision/needs-human.js";
import { omf } from "../helpers/cli.js";
import { readTree } from "../helpers/tree.js";
import { makeGitRepo, makeTempDir } from "../helpers/tmp.js";

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
    recordW(fx.ledger, "work.started", busy); // a run started it: the ledger has the event
    rewriteItem(busy, { state: "in_progress" });
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
    recordW(fx.ledger, "work.started", fx.item);
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

type Fixture = ReturnType<typeof fixture>;

/** Writes `value` as JSON under the fixture's home and returns the path, for `--file`. */
function jsonFile(fx: Fixture, name: string, value: unknown): string {
  const path = join(fx.home, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe("omf decide add and lint", () => {
  it("blocks, refreshes the block after a write, and clears it when GATE-1 passes", () => {
    const fx = fixture();
    const needs = needsHumanFile(fx.item.dir);

    // Nothing decided yet: blocked on a person (J2), exit 3, a record on disk, no spec.md (nothing was written).
    const blocked = omf(["decide", "lint", fx.id], fx.repo, fx.home);
    expect(blocked.code, blocked.stderr).toBe(3);
    expect(blocked.stdout).toContain("GATE-1: blocked_on_user (J2)");
    expect(blocked.stdout).toContain("interface_missing");
    expect(existsSync(specFile(fx.item.dir))).toBe(false);
    const first = readNeedsHuman(fx.item.dir);
    expect(first?.reasons.map((reason) => reason.code)).toContain("interface_missing");

    // A successful write refreshes the existing block instead of leaving it stale.
    const add = omf(["decide", "add", fx.id, "--file", jsonFile(fx, "add.json", ADD_INTERFACE)], fx.repo, fx.home);
    expect(add.code, add.stderr).toBe(0);
    expect(existsSync(specFile(fx.item.dir))).toBe(true);
    const second = readNeedsHuman(fx.item.dir);
    expect(second?.resume_token).not.toBe(first?.resume_token);
    expect(second?.reasons.map((reason) => reason.code)).not.toContain("interface_missing");

    // A duplicate is a refusal: exit 1 with the DecisionError message, nothing appended.
    const events = new Ledger(fx.location.dir).readVerified().length;
    const duplicate = omf(["decide", "add", fx.id, "--file", jsonFile(fx, "add.json", ADD_INTERFACE)], fx.repo, fx.home);
    expect(duplicate.code).toBe(1);
    expect(duplicate.stderr).not.toBe("");
    expect(new Ledger(fx.location.dir).readVerified()).toHaveLength(events);

    // A person closes the interface: the write itself clears the block, and lint is clean.
    runDecideResolve(fx.location, fx.id, "d-interface", RESOLVE_INTERFACE, PERSON, NOW);
    expect(existsSync(needs)).toBe(false);
    const clean = omf(["decide", "lint", fx.id], fx.repo, fx.home);
    expect(clean.code, clean.stderr).toBe(0);
    expect(clean.stdout).toContain("GATE-1: pass");
    expect(clean.stdout).toContain("spec.md: ok");
  });

  it("reports a hand-edited spec.md as drift (exit 1) and --render repairs it", () => {
    const fx = fixture();
    runDecideAdd(fx.location, fx.id, ADD_INTERFACE, "omf", NOW);
    runDecideResolve(fx.location, fx.id, "d-interface", RESOLVE_INTERFACE, PERSON, NOW);
    const spec = specFile(fx.item.dir);
    writeFileSync(spec, "edited by hand\n");

    const drift = omf(["decide", "lint", fx.id], fx.repo, fx.home);
    expect(drift.code, drift.stderr).toBe(1);
    expect(drift.stdout).toContain("spec_drift");
    expect(readFileSync(spec, "utf8")).toBe("edited by hand\n");

    const render = omf(["decide", "lint", fx.id, "--render"], fx.repo, fx.home);
    expect(render.code, render.stderr).toBe(0);
    expect(readFileSync(spec, "utf8")).not.toContain("edited by hand");
  });

  it("keeps refusals (exit 1) apart from cannot-run (exit 2) and writes nothing in either case", () => {
    const fx = fixture();
    const before = new Ledger(fx.location.dir).readVerified().length;
    const bad = omf(["decide", "add", fx.id, "--file", jsonFile(fx, "bad.json", { id: "d-interface", class: "interface" })], fx.repo, fx.home);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("add_input");
    const missing = omf(["decide", "add", fx.id, "--file", join(fx.home, "nope.json")], fx.repo, fx.home);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("cannot read");
    const unknown = omf(["decide", "lint", "w-ffffffffffff"], fx.repo, fx.home);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("unknown work item w-ffffffffffff");

    claimItem(fx.item.dir);
    try {
      const claimed = omf(["decide", "add", fx.id, "--file", jsonFile(fx, "add.json", ADD_INTERFACE)], fx.repo, fx.home);
      expect(claimed.code).toBe(2);
      expect(claimed.stderr).toContain("claimed by a run");
    } finally {
      releaseItem(fx.item.dir);
    }
    expect(new Ledger(fx.location.dir).readVerified()).toHaveLength(before);
    expect(existsSync(specFile(fx.item.dir))).toBe(false);

    // A damaged goal lock is host state that cannot be read: exit 2, like a corrupt ledger, never a refusal.
    writeFileSync(goalLockFile(fx.location.dir, "g-fast"), "{");
    const corrupt = omf(["decide", "lint", fx.id], fx.repo, fx.home);
    expect(corrupt.code, corrupt.stderr).toBe(2);
    expect(corrupt.stderr).toContain("goal lock is not valid JSON");
  });

  it("a corrupt ledger stops every verb before the file is read, and creates nothing", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    expect(omf(["init"], repo, home).code).toBe(0);
    const dir = projectDir(repo, { HOME: home });
    const file = join(dir, "ledger.jsonl");
    const event = JSON.parse(readFileSync(file, "utf8")) as { payload: Record<string, unknown> };
    event.payload.repo = "/somewhere/else";
    writeFileSync(file, `${JSON.stringify(event)}\n`);
    const before = readTree(dir);

    for (const args of [
      ["decide", "add", "w-ffffffffffff", "--file", "missing.json"],
      ["decide", "lint", "w-ffffffffffff"],
      ["decide", "show", "w-ffffffffffff"],
    ]) {
      const result = omf(args, repo, home);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.stderr, args.join(" ")).toContain("ledger corrupt at seq 1");
    }
    expect(readTree(dir)).toEqual(before);
  });
});

describe("omf decide show", () => {
  it("prints the verdict, as text and JSON, and writes nothing", () => {
    const fx = fixture();
    runDecideAdd(fx.location, fx.id, ADD_INTERFACE, "omf", NOW);
    expect(omf(["decide", "lint", fx.id], fx.repo, fx.home).code).toBe(3); // leaves needs-human.json behind
    const before = readTree(fx.location.dir);

    const text = omf(["decide", "show", fx.id], fx.repo, fx.home);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toContain("d-interface");
    expect(text.stdout).toContain("GATE-1: blocked_on_user (J2)");
    expect(text.stdout).toContain("spec.md: ok");

    const json = JSON.parse(omf(["decide", "show", fx.id, "--json"], fx.repo, fx.home).stdout) as {
      gate: string;
      decisions: { id: string; status: string }[];
    };
    expect(json.gate).toBe("blocked_on_user");
    expect(json.decisions).toEqual([expect.objectContaining({ id: "d-interface", status: "open" })]);
    expect(readTree(fx.location.dir)).toEqual(before);
  });

  it("withholds the id of a record that leaks a metric name, in text and in JSON", () => {
    const fx = fixture();
    // Appended by hand, the way a record valid before a re-lock would look: its id carries the metric stem "p95".
    fx.ledger.append({
      actor: "omf",
      type: "decision.added",
      payload: { goal_id: "g-fast", work_id: fx.id, decision_id: "d-p95-latency", class: "other", question: "What about the cache?" },
    });
    const text = omf(["decide", "show", fx.id], fx.repo, fx.home);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toContain("(withheld #");
    expect(text.stdout).not.toContain("p95");
    const lint = omf(["decide", "lint", fx.id, "--json"], fx.repo, fx.home);
    expect(lint.code).toBe(1);
    expect(lint.stdout).toContain('"code": "leak"');
    expect(lint.stdout).not.toContain("p95");
  });
});

describe("omf help", () => {
  it("lists exit code 3", () => {
    const out = omf(["--help"], makeTempDir(), makeTempDir("omf-home-"));
    expect(out.stdout).toContain("3 blocked on a person (J2: open design decisions)");
  });
});
