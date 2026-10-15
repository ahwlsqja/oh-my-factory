import { describe, expect, it } from "vitest";
import { evaluateGate1, intentQuestionIds } from "../../src/decision/gate1.js";
import type { Gate1Reason, Gate1Result } from "../../src/decision/gate1.js";
import { recordProblems } from "../../src/decision/lint.js";
import type { LeakContext } from "../../src/decision/leak-lint.js";
import type { AnomalyCode, DecisionRecord, DecisionState, InterfaceContract } from "../../src/decision/types.js";

const NOW = new Date("2026-10-14T12:00:00.000Z");
const HUMAN = "human:dev@example.com";

/** A context with nothing to leak: every record is clean under it. */
const CLEAN: LeakContext = { terms: { phrases: [] }, targetValues: [], targetNumbers: [], measuredNumbers: [] };
/** The same goal after a re-lock that made "error rate" a metric name. */
const RELOCKED: LeakContext = { ...CLEAN, terms: { phrases: ["error rate", "m error rate"] } };

function contract(over: Partial<InterfaceContract> = {}): InterfaceContract {
  return {
    kind: "cli",
    build: ["npm", "run", "build"],
    run: ["node", "dist/cli.js"],
    io_contract: "reads stdin, writes stdout",
    gates: { fast: ["npm", "run", "lint"], full: ["npm", "test"], deep: null, required: ["fast", "full"] },
    test_command: ["npm", "test"],
    ...over,
  };
}

/** An open record of class other. */
function open(id: string, over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id,
    class: "other",
    question: "Which storage engine?",
    qas: null,
    response_measure: null,
    status: "open",
    resolution: null,
    deferral: null,
    interface: null,
    na: null,
    added_by: "omf",
    added_seq: 1,
    closed_seq: null,
    measure_seq: null,
    ...over,
  };
}

function resolved(id: string, over: Partial<DecisionRecord> = {}): DecisionRecord {
  return open(id, {
    status: "resolved",
    resolution: {
      choice: "sqlite",
      rationale: "one file, no daemon",
      rejected: ["postgres"],
      by: HUMAN,
      at: NOW.toISOString(),
    },
    closed_seq: 2,
    measure_seq: null,
    ...over,
  });
}

function interfaceRecord(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return resolved("d-interface", {
    class: "interface",
    question: "What is the interface?",
    interface: contract(),
    ...over,
  });
}

function deferred(id: string, expiresAt: string, signedBy = HUMAN): DecisionRecord {
  return open(id, {
    status: "deferred",
    deferral: {
      owner: "dev",
      reason: "needs a benchmark first",
      revisit_trigger: "after the first release",
      default: "sqlite",
      signed_by: signedBy,
      expires_at: expiresAt,
    },
    closed_seq: 2,
    measure_seq: null,
  });
}

function stateOf(decisions: DecisionRecord[], anomalies: DecisionState["anomalies"] = []): DecisionState {
  return {
    scope: { goal_id: "g-0123456789ab", work_id: "w-0123456789ab" },
    decisions: decisions.map((record, index) => ({ ...record, added_seq: index + 1 })),
    anomalies,
  };
}

function gate(
  state: DecisionState,
  ids: readonly string[] = [],
  leak: LeakContext = CLEAN,
  now: Date = NOW,
): Gate1Result {
  return evaluateGate1(state, now, { leak, intentQuestionIds: ids });
}

function blocked(result: Gate1Result): Gate1Reason[] {
  if (result.status !== "blocked_on_user") throw new Error("expected GATE-1 to block");
  return result.reasons;
}

const inSeconds = (seconds: number): string => new Date(NOW.getTime() + seconds * 1000).toISOString();

describe("intentQuestionIds", () => {
  it("numbers the intent's open questions from 1", () => {
    expect(intentQuestionIds(0)).toEqual([]);
    expect(intentQuestionIds(2)).toEqual(["d-intent-q1", "d-intent-q2"]);
  });
});

describe("GATE-1 spec conditions", () => {
  it("blocks an empty state on the missing interface (empty means fail)", () => {
    const result = gate(stateOf([]));
    expect(result).toEqual({ status: "blocked_on_user", j: "J2", reasons: [{ code: "interface_missing" }] });
  });

  it("passes when the interface is resolved by a human and nothing else is pending", () => {
    expect(gate(stateOf([interfaceRecord()]))).toEqual({ status: "pass" });
  });

  it("blocks on an open decision even when the interface is resolved", () => {
    const reasons = blocked(gate(stateOf([interfaceRecord(), open("d-storage")])));
    expect(reasons).toEqual([{ code: "required_open", decision_id: "d-storage" }]);
  });

  it("reports an open interface as required_open only", () => {
    const reasons = blocked(gate(stateOf([open("d-interface", { class: "interface" })])));
    expect(reasons).toEqual([{ code: "required_open", decision_id: "d-interface" }]);
  });

  it("does not accept a deferred or not-applicable interface", () => {
    const deferredInterface = { ...deferred("d-interface", inSeconds(3600)), class: "interface" as const };
    expect(blocked(gate(stateOf([deferredInterface])))).toContainEqual({ code: "interface_unresolved" });
    const naInterface = open("d-interface", {
      class: "interface",
      status: "na",
      na: { rationale: "none", by: HUMAN, at: NOW.toISOString() },
      closed_seq: 2,
      measure_seq: null,
    });
    expect(blocked(gate(stateOf([naInterface])))).toContainEqual({ code: "interface_unresolved" });
  });

  it("passes a human-signed deferral and a human not-applicable closure", () => {
    const na = open("d-extra", {
      status: "na",
      na: { rationale: "not relevant", by: HUMAN, at: NOW.toISOString() },
      closed_seq: 2,
    });
    expect(gate(stateOf([interfaceRecord(), deferred("d-storage", inSeconds(3600)), na]))).toEqual({ status: "pass" });
  });

  it("blocks a deferral that was not signed by a human", () => {
    const reasons = blocked(gate(stateOf([interfaceRecord(), deferred("d-storage", inSeconds(3600), "omf")])));
    expect(reasons).toEqual([{ code: "deferral_unsigned", decision_id: "d-storage" }]);
  });

  it("treats an expired deferral as open, using the injected clock", () => {
    const at = (seconds: number) => gate(stateOf([interfaceRecord(), deferred("d-storage", inSeconds(seconds))]));
    expect(at(1)).toEqual({ status: "pass" });
    expect(blocked(at(0))).toEqual([
      { code: "deferral_expired", decision_id: "d-storage", expires_at: NOW.toISOString() },
    ]);
    expect(blocked(at(-1))).toHaveLength(1);
    const later = new Date(NOW.getTime() + 2000);
    expect(gate(stateOf([interfaceRecord(), deferred("d-storage", inSeconds(1))]), [], CLEAN, later).status).toBe(
      "blocked_on_user",
    );
  });

  it("blocks a deferral whose expiry does not parse", () => {
    const reasons = blocked(gate(stateOf([interfaceRecord(), deferred("d-storage", "tomorrow-ish")])));
    expect(reasons).toEqual([{ code: "deferral_expired", decision_id: "d-storage", expires_at: "tomorrow-ish" }]);
  });

  it("blocks a resolution that a non-human wrote", () => {
    const forged = resolved("d-storage", {
      resolution: { choice: "sqlite", rationale: "because", rejected: [], by: "agent:worker", at: NOW.toISOString() },
    });
    expect(blocked(gate(stateOf([interfaceRecord(), forged])))).toEqual([
      { code: "resolution_not_human", decision_id: "d-storage" },
    ]);
  });

  it("takes no link input: GATE-1 has exactly state, now and context", () => {
    expect(evaluateGate1.length).toBe(3);
  });
});

describe("GATE-1 anomalies", () => {
  const cases: [AnomalyCode, Gate1Reason][] = [
    ["malformed_event", { code: "ledger_anomaly", decision_id: "d-x", anomaly: "malformed_event" }],
    ["duplicate_add", { code: "ledger_anomaly", decision_id: "d-x", anomaly: "duplicate_add" }],
    ["unknown_decision", { code: "ledger_anomaly", decision_id: "d-x", anomaly: "unknown_decision" }],
    ["already_closed", { code: "ledger_anomaly", decision_id: "d-x", anomaly: "already_closed" }],
    ["resolution_not_human", { code: "ledger_anomaly", decision_id: "d-x", anomaly: "resolution_not_human" }],
    ["deferral_unsigned", { code: "ledger_anomaly", decision_id: "d-x", anomaly: "deferral_unsigned" }],
    ["na_not_human", { code: "ledger_anomaly", decision_id: "d-x", anomaly: "na_not_human" }],
    ["interface_misplaced", { code: "ledger_anomaly", decision_id: "d-x", anomaly: "interface_misplaced" }],
  ];

  it.each(cases)("maps the %s anomaly to a ledger_anomaly reason and never passes", (code, expected) => {
    const result = gate(stateOf([interfaceRecord()], [{ code, decision_id: "d-x", seq: 7 }]));
    expect(blocked(result)).toEqual([expected]);
  });

  it("keeps the decision a forged event tried to close open", () => {
    const open_ = open("d-storage");
    const reasons = blocked(
      gate(stateOf([interfaceRecord(), open_], [{ code: "resolution_not_human", decision_id: "d-storage", seq: 5 }])),
    );
    expect(reasons).toEqual([
      { code: "ledger_anomaly", decision_id: "d-storage", anomaly: "resolution_not_human" },
      { code: "required_open", decision_id: "d-storage" },
    ]);
  });
});

describe("GATE-1 and the open questions of the intent (F8)", () => {
  const ids = intentQuestionIds(2);

  it("blocks questions that were never seeded as decisions", () => {
    expect(blocked(gate(stateOf([interfaceRecord()]), ids))).toEqual([
      { code: "intent_question_missing", decision_id: "d-intent-q1" },
      { code: "intent_question_missing", decision_id: "d-intent-q2" },
    ]);
  });

  it("blocks seeded questions that are still open", () => {
    const seeded = [interfaceRecord(), open("d-intent-q1"), open("d-intent-q2")];
    expect(blocked(gate(stateOf(seeded), ids))).toEqual([
      { code: "required_open", decision_id: "d-intent-q1" },
      { code: "required_open", decision_id: "d-intent-q2" },
    ]);
  });

  it("passes once a human resolved or deferred each question", () => {
    const closed = [interfaceRecord(), resolved("d-intent-q1"), deferred("d-intent-q2", inSeconds(3600))];
    expect(gate(stateOf(closed), ids)).toEqual({ status: "pass" });
  });
});

describe("GATE-1 validity is part of closure (record_invalid)", () => {
  const invalid = (record: DecisionRecord, leak: LeakContext = CLEAN): Gate1Reason[] =>
    blocked(gate(stateOf([interfaceRecord(), record]), [], leak));

  it("rejects a resolved quantitative decision without a measure", () => {
    const record = resolved("d-latency", { class: "latency" });
    expect(invalid(record)).toEqual([{ code: "record_invalid", decision_id: "d-latency", problem: "measure_missing" }]);
  });

  it("rejects an interface without a body and a required gate without a command", () => {
    const noBody = blocked(gate(stateOf([interfaceRecord({ interface: null })])));
    expect(noBody).toEqual([{ code: "record_invalid", decision_id: "d-interface", problem: "interface_body_missing" }]);
    const nullGate = contract({ gates: { fast: null, full: ["npm", "test"], deep: null, required: ["fast"] } });
    const noGate = blocked(gate(stateOf([interfaceRecord({ interface: nullGate })])));
    expect(noGate).toEqual([{ code: "record_invalid", decision_id: "d-interface", problem: "gates_inconsistent" }]);
  });

  it("rejects text that leaks under a goal re-lock, though it was clean when written", () => {
    const record = resolved("d-storage", {
      resolution: {
        choice: "sqlite",
        rationale: "keeps the error rate down",
        rejected: [],
        by: HUMAN,
        at: NOW.toISOString(),
      },
    });
    expect(gate(stateOf([interfaceRecord(), record]))).toEqual({ status: "pass" });
    expect(invalid(record, RELOCKED)).toEqual([{ code: "record_invalid", decision_id: "d-storage", problem: "leak" }]);
  });

  it("judges a record against the readings that existed when it was written (A22)", () => {
    const latency = (closedSeq: number) =>
      resolved("d-latency", {
        class: "latency",
        closed_seq: closedSeq,
        measure_seq: closedSeq,
        response_measure: { ...measure(), threshold: 300 },
      });
    const later: LeakContext = { ...CLEAN, measuredNumbers: [300], readings: [{ seq: 10, value: 300 }] };
    // Closed at seq 4, before the reading at seq 10 that has the same number: still valid.
    expect(gate(stateOf([interfaceRecord(), latency(4)]), [], later)).toEqual({ status: "pass" });
    // Closed at seq 12, after that reading: the threshold equals a reading the person could have seen.
    expect(invalid(latency(12), later)).toEqual([
      { code: "record_invalid", decision_id: "d-latency", problem: "leak" },
    ]);
  });

  it("judges the add-time fields as of the add, not the close (A22)", () => {
    const later: LeakContext = { ...CLEAN, measuredNumbers: [3], readings: [{ seq: 10, value: 3 }] };
    const base = { question: "Should we keep 3 retries?", added_seq: 1, closed_seq: 20 };
    const done = resolved("d-retries", base);
    const na = open("d-retries", {
      ...base,
      status: "na",
      na: { rationale: "not relevant", by: HUMAN, at: NOW.toISOString() },
    });
    expect(recordProblems(done, later)).toEqual([]);
    expect(recordProblems(na, later)).toEqual([]);
    expect(gate(stateOf([interfaceRecord(), done]), [], later)).toEqual({ status: "pass" });
    expect(gate(stateOf([interfaceRecord(), na]), [], later)).toEqual({ status: "pass" });
  });

  it("judges a measure supplied at resolve as of the resolve, and an add-time measure as of the add", () => {
    const later: LeakContext = { ...CLEAN, measuredNumbers: [300], readings: [{ seq: 10, value: 300 }] };
    const addTime = resolved("d-latency", {
      class: "latency",
      added_seq: 1,
      closed_seq: 20,
      measure_seq: 1,
      response_measure: { ...measure(), threshold: 300 },
    });
    expect(recordProblems(addTime, later)).toEqual([]);
    const atResolve = { ...addTime, measure_seq: 20 };
    expect(recordProblems(atResolve, later)).toEqual([
      { code: "leak", decision_id: "d-latency", field: "response_measure.threshold", rule: "number-value" },
    ]);
  });

  it("rejects a planted id that carries a metric phrase", () => {
    expect(invalid(resolved("d-error-rate"), RELOCKED)).toEqual([
      { code: "record_invalid", decision_id: "d-error-rate", problem: "leak" },
    ]);
  });
});

describe("recordProblems", () => {
  it("is empty for clean open and closed records", () => {
    expect(recordProblems(open("d-a"), CLEAN)).toEqual([]);
    expect(recordProblems(interfaceRecord(), CLEAN)).toEqual([]);
    expect(recordProblems(resolved("d-latency", { class: "latency", response_measure: measure() }), CLEAN)).toEqual([]);
  });

  it("flags class interface on the wrong id, and the id d-interface on the wrong class", () => {
    expect(recordProblems(open("d-other", { class: "interface" }), CLEAN)).toEqual([
      { code: "interface_wrong_class", decision_id: "d-other" },
    ]);
    expect(recordProblems(open("d-interface", { class: "other" }), CLEAN)).toEqual([
      { code: "interface_wrong_class", decision_id: "d-interface" },
    ]);
  });

  it("names the rule and field of a leak, never the matched text", () => {
    const record = open("d-a", { question: "Reduce the error rate how?" });
    const problems = recordProblems(record, RELOCKED);
    expect(problems).toContainEqual({ code: "leak", decision_id: "d-a", field: "question", rule: "metric-name" });
    expect(problems.every((problem) => problem.code === "leak" && problem.field === "question")).toBe(true);
    expect(JSON.stringify(problems)).not.toContain("error rate");
  });

  it("flags a numeric threshold equal to the locked target", () => {
    const record = resolved("d-latency", { class: "latency", response_measure: { ...measure(), threshold: 12 } });
    const ctx: LeakContext = { ...CLEAN, targetNumbers: [12], targetValues: ["12"] };
    expect(recordProblems(record, ctx)).toContainEqual({
      code: "leak",
      decision_id: "d-latency",
      field: "response_measure.threshold",
      rule: "number-value",
    });
  });
});

function measure() {
  return { metric: "request latency", op: "<=" as const, threshold: 250, unit: "ms", percentile: 95, window: null };
}
