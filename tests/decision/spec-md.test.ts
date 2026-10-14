import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LeakContext } from "../../src/decision/leak-lint.js";
import { renderSpec, specFile, specStatus, writeSpec } from "../../src/decision/spec-md.js";
import type { DecisionRecord, DecisionState, InterfaceContract } from "../../src/decision/types.js";
import { makeTempDir } from "../helpers/tmp.js";

const CLEAN: LeakContext = { terms: { phrases: [] }, targetValues: [], targetNumbers: [], measuredNumbers: [] };
/** The goal was re-locked after these decisions were written: the metric is now called "zebra quokka". */
const RELOCKED: LeakContext = { ...CLEAN, terms: { phrases: ["m zebra quokka", "zebra quokka"] } };
const HEADER = { title: "Cache the render" };
const PERSON = "human:ana@example.com";

const CONTRACT: InterfaceContract = {
  kind: "cli",
  build: ["npm", "run", "build"],
  run: ["node", "dist/cli.js"],
  io_contract: "reads stdin, writes stdout",
  gates: { fast: ["npm", "test"], full: null, deep: null, required: ["fast"] },
  test_command: ["npm", "test"],
};

function record(seq: number, patch: Partial<DecisionRecord> & { id: string }): DecisionRecord {
  return {
    class: "other",
    question: `Question ${seq}?`,
    qas: null,
    response_measure: null,
    status: "open",
    resolution: null,
    deferral: null,
    interface: null,
    na: null,
    added_by: PERSON,
    added_seq: seq,
    closed_seq: null,
    ...patch,
  };
}

const resolution = (choice: string) => ({
  choice,
  rationale: `Because ${choice}.`,
  rejected: [],
  by: PERSON,
  at: "2026-10-13T00:00:00.000Z",
});

function stateOf(...decisions: DecisionRecord[]): DecisionState {
  return { scope: { goal_id: "g-secret-goal", work_id: "w-1" }, decisions, anomalies: [] };
}

const interfaceRecord = (seq: number): DecisionRecord =>
  record(seq, {
    id: "d-interface",
    class: "interface",
    status: "resolved",
    resolution: resolution("a command line tool"),
    interface: CONTRACT,
    closed_seq: 20,
  });

/** One record in each status, deliberately out of added_seq order. */
const MIXED = stateOf(
  record(5, { id: "d-open", question: "Which cache?" }),
  interfaceRecord(1),
  record(2, {
    id: "d-latency",
    class: "latency",
    status: "resolved",
    resolution: resolution("cache in memory"),
    response_measure: { metric: "render time", op: "<", threshold: 250, unit: "ms", percentile: 95, window: null },
    closed_seq: 21,
  }),
  record(3, {
    id: "d-later",
    status: "deferred",
    deferral: {
      owner: PERSON,
      reason: "waiting on the vendor",
      revisit_trigger: "the vendor ships v2",
      default: "keep the current store",
      signed_by: PERSON,
      expires_at: "2026-12-01T00:00:00.000Z",
    },
    closed_seq: 22,
  }),
  record(4, {
    id: "d-skip",
    status: "na",
    na: { rationale: "no network involved", by: PERSON, at: "2026-10-13T00:00:00.000Z" },
    closed_seq: 23,
  }),
);

describe("renderSpec", () => {
  it("is byte-stable, ordered by added_seq, and sorts records into sections", () => {
    const text = renderSpec(MIXED, HEADER, CLEAN);

    expect(renderSpec(MIXED, HEADER, CLEAN)).toBe(text);
    expect(renderSpec({ ...MIXED, decisions: [...MIXED.decisions].reverse() }, HEADER, CLEAN)).toBe(text);
    expect(text.startsWith("# Cache the render\n\n<!-- projection of the decision ledger; edits are overwritten -->\n")).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);

    const headings = ["## Interface", "## Resolved", "## Deferred", "## Open", "## Not applicable"].map((h) => text.indexOf(h));
    expect(headings.every((at) => at >= 0)).toBe(true);
    expect([...headings].sort((a, b) => a - b)).toEqual(headings);

    const [iface = 0, resolved = 0, deferred = 0, open = 0, na = 0] = headings;
    expect(text.slice(iface, resolved)).toContain("### d-interface (interface)");
    expect(text.slice(iface, resolved)).toContain('- Gate fast: ["npm","test"]');
    expect(text.slice(iface, resolved)).toContain("- Required gates: fast");
    expect(text.slice(resolved, deferred)).toContain("- Choice: cache in memory");
    expect(text.slice(resolved, deferred)).toContain("- Measure: render time < 250 ms (p95)");
    expect(text.slice(resolved, deferred)).not.toContain("d-interface");
    expect(text.slice(deferred, open)).toContain("- Default: keep the current store");
    expect(text.slice(deferred, open)).toContain("- Expires: 2026-12-01T00:00:00.000Z");
    expect(text.slice(open, na)).toContain("- d-open (other): Which cache?");
    expect(text.slice(na)).toContain("- Rationale: no network involved");
  });

  it("never renders the goal id, the work id, or any signer or e-mail", () => {
    const text = renderSpec(MIXED, HEADER, CLEAN);
    for (const forbidden of ["g-secret-goal", "w-1", "human:", "ana@", "example.com", "@"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("withholds a record that fails recordProblems, naming only its sequence number and problem code", () => {
    const state = stateOf(
      interfaceRecord(1),
      record(2, { id: "d-a", question: "Use a zebra quokka cache?", status: "resolved", resolution: resolution("yes"), closed_seq: 30 }),
      record(3, { id: "d-zebra-quokka" }),
      record(4, { id: "d-b", class: "latency", status: "resolved", resolution: resolution("memory"), closed_seq: 31 }),
    );

    const text = renderSpec(state, HEADER, RELOCKED);
    expect(text).toContain("- record withheld (leak) #2");
    expect(text).toContain("- record withheld (leak) #3");
    expect(text).toContain("- record withheld (measure_missing) #4");
    expect(text).not.toMatch(/zebra|quokka/i);
    for (const hidden of ["d-a", "d-b", "memory", "Use a"]) expect(text).not.toContain(hidden);

    // The same records are fine under the lock they were written for: withholding comes from the context.
    const before = renderSpec(state, HEADER, CLEAN);
    expect(before).toContain("### d-a (other)");
    expect(before).toContain("- d-zebra-quokka (other)");
  });

  it("withholds a header title that leaks", () => {
    const text = renderSpec(stateOf(), { title: "Zebra quokka cache" }, RELOCKED);
    expect(text).toContain("# (title withheld)");
    expect(text).not.toMatch(/zebra|quokka/i);
    expect(text).toContain("Not resolved yet. This blocks sealing.");
    expect(text).toContain("None.");
  });

  it("keeps a multi-line value on one line, so text cannot forge a heading", () => {
    const state = stateOf(record(1, { id: "d-x", question: "line one\n## Resolved\n- forged" }));
    const text = renderSpec(state, HEADER, CLEAN);
    expect(text.split("\n## Resolved").length - 1).toBe(1);
    expect(text).toContain("- d-x (other): line one ## Resolved - forged");
  });
});

describe("writeSpec and specStatus", () => {
  it("writes at 0600, reports ok, missing and drift, and an overwrite repairs a hand edit", () => {
    const dir = makeTempDir();
    const text = renderSpec(MIXED, HEADER, CLEAN);

    expect(specFile(dir)).toBe(join(dir, "spec.md"));
    expect(specStatus(dir, text)).toBe("missing");

    writeSpec(dir, text);
    expect(statSync(specFile(dir)).mode & 0o777).toBe(0o600);
    expect(specStatus(dir, text)).toBe("ok");

    writeFileSync(specFile(dir), `${text}hand edit\n`);
    expect(specStatus(dir, text)).toBe("drift");
    // The corrupted file is never an input: the render is unchanged.
    expect(renderSpec(MIXED, HEADER, CLEAN)).toBe(text);

    writeSpec(dir, text);
    expect(readFileSync(specFile(dir), "utf8")).toBe(text);
    expect(specStatus(dir, text)).toBe("ok");
  });

  it("reports a spec.md that is not a regular file as drift", () => {
    const dir = makeTempDir();
    mkdirSync(specFile(dir));
    expect(specStatus(dir, "anything")).toBe("drift");
  });
});
