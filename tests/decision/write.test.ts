import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/core/canonical-json.js";
import { Ledger } from "../../src/core/ledger.js";
import type { LeakContext } from "../../src/decision/leak-lint.js";
import { findDecision, foldDecisions } from "../../src/decision/state.js";
import type {
  AddInput,
  DecisionClass,
  DecisionScope,
  InterfaceContract,
  ResponseMeasure,
} from "../../src/decision/types.js";
import {
  DecisionError,
  addDecision,
  deferDecision,
  markNotApplicable,
  resolveDecision,
  seedEvents,
} from "../../src/decision/write.js";
import type { WriteContext } from "../../src/decision/write.js";
import { runChild } from "../helpers/child.js";
import { makeTempDir } from "../helpers/tmp.js";

const SCOPE: DecisionScope = { goal_id: "g-demo", work_id: "w-0123456789ab" };
const NOW = new Date("2026-10-14T00:00:00.000Z");
const HUMAN = "human:dev@example.invalid";

/** A goal whose metric is m-zebra-quokka with target 3719.25 and one reading of 4817.39 (the E2 canaries). */
const LEAK: LeakContext = {
  terms: { phrases: ["m zebra quokka", "zebra quokka"] },
  targetValues: ["3719.25"],
  targetNumbers: [3719.25],
  measuredNumbers: [4817.39],
};

const ctxFor = (intentQuestions: readonly string[] = []): WriteContext => ({ leak: LEAK, intentQuestions, now: NOW });

const CONTRACT: InterfaceContract = {
  kind: "cli",
  build: ["npm", "run", "build"],
  run: ["node", "dist/cli.js"],
  io_contract: "reads lines on stdin, writes lines on stdout",
  gates: { fast: ["npm", "test"], full: null, deep: null, required: ["fast"] },
  test_command: ["npm", "test"],
};

const MEASURE: ResponseMeasure = {
  metric: "checkout render time",
  op: "<",
  threshold: 300,
  unit: "ms",
  percentile: 95,
  window: null,
};

const CHOICE = { choice: "Write JSON lines", rationale: "Easy to append and to diff.", rejected: ["CSV"] };

const newLedger = (): Ledger => new Ledger(makeTempDir("omf-decide-write-"));
const entry = (id: string, cls: DecisionClass = "other"): AddInput => ({
  id,
  class: cls,
  question: "Which file format do we write?",
});
const stateOf = (ledger: Ledger) => foldDecisions(ledger.readVerified(), SCOPE);
const statusOf = (ledger: Ledger, id: string) => findDecision(stateOf(ledger), id)?.status;
const count = (ledger: Ledger): number => ledger.readVerified().length;

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof DecisionError ? err.code : `other: ${String(err)}`;
  }
  return "no error";
}

describe("addDecision", () => {
  it("accepts omf, an agent and a human, and records the actor", () => {
    const ledger = newLedger();
    for (const [id, actor] of [
      ["d-a", "omf"],
      ["d-b", "agent:x"],
      ["d-c", "human:y"],
    ] as const) {
      const event = addDecision(ledger, SCOPE, entry(id), actor, ctxFor());
      expect(event).toMatchObject({
        type: "decision.added",
        actor,
        payload: { decision_id: id, goal_id: "g-demo", work_id: "w-0123456789ab" },
      });
    }
    expect(stateOf(ledger).decisions.map((d) => [d.id, d.status])).toEqual([
      ["d-a", "open"],
      ["d-b", "open"],
      ["d-c", "open"],
    ]);
  });

  it("refuses a duplicate id and bad input without writing", () => {
    const ledger = newLedger();
    addDecision(ledger, SCOPE, entry("d-a"), "omf", ctxFor());
    expect(codeOf(() => addDecision(ledger, SCOPE, entry("d-a"), "omf", ctxFor()))).toBe("duplicate_id");
    expect(codeOf(() => addDecision(ledger, SCOPE, entry("Bad Id"), "omf", ctxFor()))).toBe("invalid_input");
    expect(codeOf(() => addDecision(ledger, SCOPE, { ...entry("d-a"), question: "" }, "omf", ctxFor()))).toBe(
      "invalid_input",
    );
    expect(count(ledger)).toBe(1);
  });

  it("pairs class interface with the id d-interface, both ways", () => {
    const ledger = newLedger();
    expect(codeOf(() => addDecision(ledger, SCOPE, entry("d-api", "interface"), "omf", ctxFor()))).toBe(
      "invalid_input",
    );
    expect(codeOf(() => addDecision(ledger, SCOPE, entry("d-interface", "other"), "omf", ctxFor()))).toBe(
      "invalid_input",
    );
    expect(count(ledger)).toBe(0);
    addDecision(ledger, SCOPE, entry("d-interface", "interface"), "omf", ctxFor());
    expect(statusOf(ledger, "d-interface")).toBe("open");
  });
});

describe("resolveDecision", () => {
  it("is human only: omf and agents throw not_human and append nothing", () => {
    const ledger = newLedger();
    addDecision(ledger, SCOPE, entry("d-a"), "omf", ctxFor());
    for (const actor of ["omf", "agent:x"]) {
      expect(codeOf(() => resolveDecision(ledger, SCOPE, "d-a", CHOICE, actor, ctxFor()))).toBe("not_human");
    }
    expect(count(ledger)).toBe(1);
    expect(statusOf(ledger, "d-a")).toBe("open");
  });

  it("closes a decision, signing it with the actor and the injected clock", () => {
    const ledger = newLedger();
    addDecision(ledger, SCOPE, entry("d-a"), "omf", ctxFor());
    const event = resolveDecision(
      ledger,
      SCOPE,
      "d-a",
      { choice: CHOICE.choice, rationale: CHOICE.rationale },
      HUMAN,
      ctxFor(),
    );
    expect(event.payload.resolution).toEqual({
      choice: CHOICE.choice,
      rationale: CHOICE.rationale,
      rejected: [],
      by: HUMAN,
      at: NOW.toISOString(),
    });
    expect(statusOf(ledger, "d-a")).toBe("resolved");
  });

  it("refuses an unknown decision and a closed one", () => {
    const ledger = newLedger();
    addDecision(ledger, SCOPE, entry("d-a"), "omf", ctxFor());
    expect(codeOf(() => resolveDecision(ledger, SCOPE, "d-nope", CHOICE, HUMAN, ctxFor()))).toBe("unknown_decision");
    resolveDecision(ledger, SCOPE, "d-a", CHOICE, HUMAN, ctxFor());
    expect(codeOf(() => resolveDecision(ledger, SCOPE, "d-a", CHOICE, HUMAN, ctxFor()))).toBe("already_closed");
    expect(count(ledger)).toBe(2);
  });

  it("needs a valid interface body for d-interface and refuses one anywhere else", () => {
    const ledger = newLedger();
    addDecision(ledger, SCOPE, entry("d-interface", "interface"), "omf", ctxFor());
    addDecision(ledger, SCOPE, entry("d-a"), "omf", ctxFor());
    expect(codeOf(() => resolveDecision(ledger, SCOPE, "d-interface", CHOICE, HUMAN, ctxFor()))).toBe(
      "interface_required",
    );
    const nullGate = { ...CONTRACT, gates: { ...CONTRACT.gates, required: ["full" as const] } };
    expect(
      codeOf(() => resolveDecision(ledger, SCOPE, "d-interface", { ...CHOICE, interface: nullGate }, HUMAN, ctxFor())),
    ).toBe("invalid_input");
    expect(
      codeOf(() => resolveDecision(ledger, SCOPE, "d-a", { ...CHOICE, interface: CONTRACT }, HUMAN, ctxFor())),
    ).toBe("invalid_input");
    expect(count(ledger)).toBe(2);
    resolveDecision(ledger, SCOPE, "d-interface", { ...CHOICE, interface: CONTRACT }, HUMAN, ctxFor());
    expect(findDecision(stateOf(ledger), "d-interface")?.interface).toEqual(CONTRACT);
  });

  it("needs a numeric measure for a quantitative class, from the add or from the resolve", () => {
    const ledger = newLedger();
    addDecision(ledger, SCOPE, entry("d-lat", "latency"), "omf", ctxFor());
    addDecision(ledger, SCOPE, { ...entry("d-mem", "memory"), response_measure: MEASURE }, "omf", ctxFor());
    expect(codeOf(() => resolveDecision(ledger, SCOPE, "d-lat", CHOICE, HUMAN, ctxFor()))).toBe("invalid_input");
    resolveDecision(ledger, SCOPE, "d-lat", { ...CHOICE, response_measure: MEASURE }, HUMAN, ctxFor());
    resolveDecision(ledger, SCOPE, "d-mem", CHOICE, HUMAN, ctxFor());
    expect(["d-lat", "d-mem"].map((id) => statusOf(ledger, id))).toEqual(["resolved", "resolved"]);
  });
});

describe("deferDecision and markNotApplicable", () => {
  const DEFERRAL = {
    owner: "dev",
    reason: "Waiting on the storage review.",
    revisit_trigger: "Storage review is done.",
    default: "Write JSON lines.",
    expires_at: "2026-11-14T00:00:00.000Z",
  };

  it("defers as a human, signs it, and refuses a past or unparseable expiry", () => {
    const ledger = newLedger();
    addDecision(ledger, SCOPE, entry("d-a"), "omf", ctxFor());
    expect(codeOf(() => deferDecision(ledger, SCOPE, "d-a", DEFERRAL, "agent:x", ctxFor()))).toBe("not_human");
    expect(
      codeOf(() =>
        deferDecision(ledger, SCOPE, "d-a", { ...DEFERRAL, expires_at: "2026-10-13T00:00:00.000Z" }, HUMAN, ctxFor()),
      ),
    ).toBe("deferral_in_past");
    expect(
      codeOf(() =>
        deferDecision(ledger, SCOPE, "d-a", { ...DEFERRAL, expires_at: NOW.toISOString() }, HUMAN, ctxFor()),
      ),
    ).toBe("deferral_in_past");
    expect(
      codeOf(() =>
        deferDecision(ledger, SCOPE, "d-a", { ...DEFERRAL, expires_at: "2026-13-45T00:00:00Z" }, HUMAN, ctxFor()),
      ),
    ).toBe("invalid_input");
    expect(count(ledger)).toBe(1);
    const event = deferDecision(ledger, SCOPE, "d-a", DEFERRAL, HUMAN, ctxFor());
    expect(event.payload.deferral).toMatchObject({ signed_by: HUMAN, expires_at: DEFERRAL.expires_at });
    expect(statusOf(ledger, "d-a")).toBe("deferred");
  });

  it("lets a person resolve, defer again or mark n/a a deferred decision, and keeps resolved final (A21)", () => {
    const ledger = newLedger();
    for (const id of ["d-a", "d-b", "d-c"]) {
      addDecision(ledger, SCOPE, entry(id), "omf", ctxFor());
      deferDecision(ledger, SCOPE, id, DEFERRAL, HUMAN, ctxFor());
    }
    resolveDecision(ledger, SCOPE, "d-a", CHOICE, HUMAN, ctxFor());
    deferDecision(ledger, SCOPE, "d-b", { ...DEFERRAL, expires_at: "2026-12-14T00:00:00.000Z" }, HUMAN, ctxFor());
    markNotApplicable(ledger, SCOPE, "d-c", { rationale: "Not needed." }, HUMAN, ctxFor());
    expect(["d-a", "d-b", "d-c"].map((id) => statusOf(ledger, id))).toEqual(["resolved", "deferred", "na"]);
    expect(findDecision(stateOf(ledger), "d-b")?.deferral?.expires_at).toBe("2026-12-14T00:00:00.000Z");
    expect(stateOf(ledger).anomalies).toEqual([]);
    expect(codeOf(() => deferDecision(ledger, SCOPE, "d-a", DEFERRAL, HUMAN, ctxFor()))).toBe("already_closed");
    expect(codeOf(() => markNotApplicable(ledger, SCOPE, "d-a", { rationale: "Not needed." }, HUMAN, ctxFor()))).toBe(
      "already_closed",
    );
  });

  it("marks n/a as a human, and never closes the interface decision either way", () => {
    const ledger = newLedger();
    addDecision(ledger, SCOPE, entry("d-a"), "omf", ctxFor());
    addDecision(ledger, SCOPE, entry("d-interface", "interface"), "omf", ctxFor());
    expect(codeOf(() => markNotApplicable(ledger, SCOPE, "d-a", { rationale: "Not needed." }, "omf", ctxFor()))).toBe(
      "not_human",
    );
    markNotApplicable(ledger, SCOPE, "d-a", { rationale: "Not needed." }, HUMAN, ctxFor());
    expect(statusOf(ledger, "d-a")).toBe("na");
    expect(
      codeOf(() => markNotApplicable(ledger, SCOPE, "d-interface", { rationale: "Not needed." }, HUMAN, ctxFor())),
    ).toBe("interface_not_closable");
    expect(codeOf(() => deferDecision(ledger, SCOPE, "d-interface", DEFERRAL, HUMAN, ctxFor()))).toBe(
      "interface_not_closable",
    );
    expect(statusOf(ledger, "d-interface")).toBe("open");
  });
});

describe("a refusal is always a valid record", () => {
  const DEFERRAL = {
    owner: "dev",
    reason: "Waiting on the storage review.",
    revisit_trigger: "Storage review is done.",
    default: "Write JSON lines.",
    expires_at: "2026-11-14T00:00:00.000Z",
  };

  it("refuses a malformed decision id before anything is appended", () => {
    const ledger = newLedger();
    addDecision(ledger, SCOPE, entry("d-a"), "omf", ctxFor());
    for (const id of ["D-A", "d-", "x y", ""]) {
      expect(
        codeOf(() => resolveDecision(ledger, SCOPE, id, CHOICE, HUMAN, ctxFor())),
        `resolve ${id}`,
      ).toBe("invalid_input");
      expect(
        codeOf(() => deferDecision(ledger, SCOPE, id, DEFERRAL, HUMAN, ctxFor())),
        `defer ${id}`,
      ).toBe("invalid_input");
      expect(
        codeOf(() => markNotApplicable(ledger, SCOPE, id, { rationale: "Not needed." }, HUMAN, ctxFor())),
        `na ${id}`,
      ).toBe("invalid_input");
    }
    expect(count(ledger)).toBe(1);
  });

  it("caps the findings of a rejection at the schema's 50 and keeps the ledger free of anomalies", () => {
    const ledger = newLedger();
    addDecision(ledger, SCOPE, entry("d-interface", "interface"), "omf", ctxFor());
    const leakyContract = { ...CONTRACT, run: ["node", ...Array.from({ length: 60 }, () => "zebra quokka")] };
    expect(
      codeOf(() =>
        resolveDecision(ledger, SCOPE, "d-interface", { ...CHOICE, interface: leakyContract }, HUMAN, ctxFor()),
      ),
    ).toBe("leak");
    const rejected = ledger.readVerified().at(-1);
    expect(rejected?.type).toBe("decision.rejected");
    expect((rejected?.payload.findings as unknown[]).length).toBe(50);
    expect(stateOf(ledger).anomalies).toEqual([]);
  });
});

describe("goal leakage", () => {
  it("records one decision.rejected with rule and field only, and throws leak", () => {
    const ledger = newLedger();
    const leaky = { ...entry("d-a"), question: "Should the zebra quokka path stay?" };
    expect(codeOf(() => addDecision(ledger, SCOPE, leaky, "omf", ctxFor()))).toBe("leak");
    const events = ledger.readVerified();
    expect(events.map((e) => e.type)).toEqual(["decision.rejected"]);
    const payload = events[0]?.payload;
    expect(payload).toMatchObject({
      op: "add",
      decision_id: "d-a",
      findings: [{ rule: "metric-name", field: "question" }],
    });
    expect(JSON.stringify(payload)).not.toMatch(/zebra|quokka/i);
  });

  it("refuses a threshold equal to the locked target, as a number", () => {
    const ledger = newLedger();
    addDecision(ledger, SCOPE, entry("d-lat", "latency"), "omf", ctxFor());
    const leaky = { ...CHOICE, response_measure: { ...MEASURE, threshold: 3719.25 } };
    expect(codeOf(() => resolveDecision(ledger, SCOPE, "d-lat", leaky, HUMAN, ctxFor()))).toBe("leak");
    const last = ledger.readVerified().at(-1);
    expect(last?.type).toBe("decision.rejected");
    expect(last?.payload).toMatchObject({
      op: "resolve",
      findings: [expect.objectContaining({ rule: "number-value" })],
    });
    expect(JSON.stringify(last?.payload)).not.toContain("3719");
    expect(statusOf(ledger, "d-lat")).toBe("open");
  });

  it("refuses a leaking id before any decision event and records only its hash", () => {
    const ledger = newLedger();
    expect(codeOf(() => addDecision(ledger, SCOPE, entry("d-zebra-quokka"), "omf", ctxFor()))).toBe("leak");
    const events = ledger.readVerified();
    expect(events.map((e) => e.type)).toEqual(["decision.rejected"]);
    const payload = events[0]?.payload ?? {};
    expect(payload).not.toHaveProperty("decision_id");
    expect(payload.decision_id_sha12).toBe(sha256Hex("d-zebra-quokka").slice(0, 12));
    expect(JSON.stringify(payload)).not.toMatch(/zebra|quokka/i);
  });

  it("accepts a clean numeric threshold that is neither the target nor a reading", () => {
    const ledger = newLedger();
    addDecision(ledger, SCOPE, entry("d-lat", "latency"), "omf", ctxFor());
    resolveDecision(ledger, SCOPE, "d-lat", { ...CHOICE, response_measure: MEASURE }, HUMAN, ctxFor());
    expect(statusOf(ledger, "d-lat")).toBe("resolved");
  });

  it("checks a closing verb's id against the lock but not against readings recorded after the add (A22)", () => {
    const ledger = newLedger();
    // 4817 is the integer part of the reading 4817.39, which the context of the add does not know yet.
    addDecision(ledger, SCOPE, entry("d-cap-4817"), "omf", { ...ctxFor(), leak: { ...LEAK, measuredNumbers: [] } });
    const relocked: WriteContext = { ...ctxFor(), leak: { ...LEAK, targetValues: ["4817"], targetNumbers: [4817] } };
    expect(codeOf(() => resolveDecision(ledger, SCOPE, "d-cap-4817", CHOICE, HUMAN, relocked))).toBe("leak");
    resolveDecision(ledger, SCOPE, "d-cap-4817", CHOICE, HUMAN, ctxFor());
    expect(statusOf(ledger, "d-cap-4817")).toBe("resolved");
  });
});

describe("intent-question seeding", () => {
  const QUESTIONS = ["Which store holds the queue?", "Who owns retries?"];

  it("seeds the missing d-intent-q<n> decisions in the first write, once", () => {
    const ledger = newLedger();
    addDecision(ledger, SCOPE, entry("d-a"), "human:y", ctxFor(QUESTIONS));
    const first = ledger.readVerified();
    expect(first.map((e) => [e.type, e.actor, e.payload.decision_id])).toEqual([
      ["decision.added", "omf", "d-intent-q1"],
      ["decision.added", "omf", "d-intent-q2"],
      ["decision.added", "human:y", "d-a"],
    ]);
    expect(first[0]?.payload).toMatchObject({ class: "other", question: QUESTIONS[0] });
    addDecision(ledger, SCOPE, entry("d-b"), "omf", ctxFor(QUESTIONS));
    expect(count(ledger)).toBe(4);
  });

  it("lets the very first write be a resolve of a seeded id", () => {
    const ledger = newLedger();
    resolveDecision(ledger, SCOPE, "d-intent-q1", CHOICE, HUMAN, ctxFor(QUESTIONS));
    expect(ledger.readVerified().map((e) => [e.type, e.payload.decision_id])).toEqual([
      ["decision.added", "d-intent-q1"],
      ["decision.added", "d-intent-q2"],
      ["decision.resolved", "d-intent-q1"],
    ]);
    expect(statusOf(ledger, "d-intent-q1")).toBe("resolved");
    expect(statusOf(ledger, "d-intent-q2")).toBe("open");
  });

  it("seeds nothing when the write fails its precondition", () => {
    const ledger = newLedger();
    expect(codeOf(() => resolveDecision(ledger, SCOPE, "d-nope", CHOICE, HUMAN, ctxFor(QUESTIONS)))).toBe(
      "unknown_decision",
    );
    expect(count(ledger)).toBe(0);
  });

  it("truncates a long question to 1000 characters and names only the missing ids", () => {
    const state = foldDecisions([], SCOPE);
    const seeds = seedEvents(state, SCOPE, ["x".repeat(1500), "short"]);
    expect(seeds).toHaveLength(2);
    expect(String(seeds[0]?.payload.question)).toHaveLength(1000);
    const ledger = newLedger();
    addDecision(ledger, SCOPE, entry("d-a"), "omf", ctxFor(["one"]));
    const after = seedEvents(stateOf(ledger), SCOPE, ["one", "two"]);
    expect(after.map((e) => e.payload.decision_id)).toEqual(["d-intent-q2"]);
  });
});

/** Child: one add of the same id in its own process. Prints "ok" or the DecisionError code. */
const CHILD = `
const { Ledger } = await import(process.argv[1]);
const { addDecision, DecisionError } = await import(process.argv[2]);
const { dir, scope, input, leak } = JSON.parse(process.argv[3]);
try {
  addDecision(new Ledger(dir), scope, input, "omf", { leak, intentQuestions: [], now: new Date() });
  console.log("ok");
} catch (err) {
  console.log(err instanceof DecisionError ? err.code : "other: " + err.message);
}
`;

describe("preconditions are atomic with the append", () => {
  it("lets exactly one of four concurrent adds of the same id through", async () => {
    const dir = makeTempDir("omf-decide-race-");
    const args = [
      resolve("dist/core/ledger.js"),
      resolve("dist/decision/write.js"),
      JSON.stringify({ dir, scope: SCOPE, input: entry("d-race"), leak: LEAK }),
    ];
    const runs = await Promise.all([1, 2, 3, 4].map(() => runChild(CHILD, args)));
    expect(runs.map((r) => r.code)).toEqual([0, 0, 0, 0]);
    expect(runs.map((r) => r.out.trim()).sort()).toEqual(["duplicate_id", "duplicate_id", "duplicate_id", "ok"]);
    const added = new Ledger(dir).readVerified().filter((e) => e.type === "decision.added");
    expect(added).toHaveLength(1);
  });
});
