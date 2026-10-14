import { describe, expect, it } from "vitest";
import { lintDecisions, scenarioLinkCoverage } from "../../src/decision/lint.js";
import type { DecisionLinks } from "../../src/decision/lint.js";
import type { LeakContext } from "../../src/decision/leak-lint.js";
import type { Anomaly, DecisionRecord, DecisionState, InterfaceContract, ResponseMeasure } from "../../src/decision/types.js";
import { CANARY } from "../helpers/canary.js";

const HUMAN = "human:dev@example.com";
const AT = "2026-10-12T00:00:00.000Z";

const CLEAN_LEAK: LeakContext = { terms: { phrases: [] }, targetValues: [], targetNumbers: [], measuredNumbers: [] };
/** A lock whose metric id is the canary: the full phrase `zebra quokka` is forbidden in decision text. */
const CANARY_LEAK: LeakContext = {
  terms: { phrases: ["m zebra quokka", CANARY.metricWords.join(" ")] },
  targetValues: [CANARY.target],
  targetNumbers: [Number(CANARY.target)],
  measuredNumbers: [],
};

const CONTRACT: InterfaceContract = {
  kind: "cli",
  build: ["npm", "run", "build"],
  run: ["node", "dist/main.js"],
  io_contract: "Reads one line on stdin, prints one line on stdout.",
  gates: { fast: ["npm", "test"], full: null, deep: null, required: ["fast"] },
  test_command: ["npm", "test"],
};

const MEASURE: ResponseMeasure = {
  metric: "p99 request time",
  op: "<=",
  threshold: 250,
  unit: "ms",
  percentile: 99,
  window: null,
};

let nextSeq = 1;
/** A resolved, valid record unless `over` says otherwise. */
function record(id: string, over: Partial<DecisionRecord> = {}): DecisionRecord {
  const seq = nextSeq++;
  return {
    id,
    class: "other",
    question: "Which retry policy do we use?",
    qas: null,
    response_measure: null,
    status: "resolved",
    resolution: { choice: "Retry twice.", rationale: "Cheap and bounded.", rejected: [], by: HUMAN, at: AT },
    deferral: null,
    interface: null,
    na: null,
    added_by: "omf",
    added_seq: seq,
    closed_seq: seq + 1000,
    measure_seq: null,
    ...over,
  };
}

function stateOf(decisions: DecisionRecord[], anomalies: Anomaly[] = []): DecisionState {
  return { scope: { goal_id: "g-a", work_id: "w-a" }, decisions, anomalies };
}

const codes = (problems: { code: string }[]): string[] => problems.map((problem) => problem.code);

const interfaceRecord = (over: Partial<DecisionRecord> = {}): DecisionRecord =>
  record("d-interface", { class: "interface", question: "How is it invoked?", interface: CONTRACT, ...over });
const latencyRecord = (over: Partial<DecisionRecord> = {}): DecisionRecord =>
  record("d-latency", { class: "latency", question: "How fast must it answer?", response_measure: MEASURE, ...over });

describe("lintDecisions: per-record problems", () => {
  it("reports nothing for a state whose records are all valid", () => {
    const state = stateOf([interfaceRecord(), latencyRecord(), record("d-retry")]);
    expect(lintDecisions(state, CLEAN_LEAK, [])).toEqual([]);
  });

  it("flags a resolved quantitative decision with no numeric measure", () => {
    const state = stateOf([interfaceRecord(), latencyRecord({ response_measure: null })]);
    expect(lintDecisions(state, CLEAN_LEAK, [])).toContainEqual(
      expect.objectContaining({ code: "measure_missing", decision_id: "d-latency" }),
    );
  });

  it("flags a required gate with no command", () => {
    const broken: InterfaceContract = { ...CONTRACT, gates: { ...CONTRACT.gates, required: ["fast", "full"] } };
    const state = stateOf([interfaceRecord({ interface: broken })]);
    expect(lintDecisions(state, CLEAN_LEAK, [])).toContainEqual(
      expect.objectContaining({ code: "gates_inconsistent", decision_id: "d-interface" }),
    );
  });

  it("flags class interface under another id and a resolved interface with no body", () => {
    const wrongId = lintDecisions(stateOf([record("d-api", { class: "interface", interface: CONTRACT })]), CLEAN_LEAK, []);
    expect(codes(wrongId)).toContain("interface_wrong_class");
    const noBody = lintDecisions(stateOf([interfaceRecord({ interface: null })]), CLEAN_LEAK, []);
    expect(codes(noBody)).toContain("interface_body_missing");
  });

  it("reports a leak by rule and field only, never by the matched text", () => {
    const leaky = record("d-retry", { question: `Does ${CANARY.metricWords.join(" ")} get worse on retry?` });
    const problems = lintDecisions(stateOf([interfaceRecord(), leaky]), CANARY_LEAK, []);
    const leak = problems.filter((problem) => problem.code === "leak");
    expect(leak).toHaveLength(1);
    expect(leak[0]).toMatchObject({ decision_id: "d-retry", rule: "metric-name" });
    expect(typeof leak[0]?.field).toBe("string");
    for (const word of CANARY.metricWords) expect(JSON.stringify(problems)).not.toContain(word);
  });
});

describe("lintDecisions: anomalies and intent questions", () => {
  it("passes ledger anomalies through with the anomaly code as detail", () => {
    const anomalies: Anomaly[] = [{ code: "resolution_not_human", decision_id: "d-retry", seq: 7 }];
    expect(lintDecisions(stateOf([interfaceRecord()], anomalies), CLEAN_LEAK, [])).toContainEqual({
      code: "anomaly",
      decision_id: "d-retry",
      detail: "resolution_not_human",
    });
  });

  it("reports each intent question that has no record, and only those", () => {
    const state = stateOf([interfaceRecord(), record("d-intent-q1", { class: "other" })]);
    const problems = lintDecisions(state, CLEAN_LEAK, ["d-intent-q1", "d-intent-q2", "d-intent-q3"]);
    expect(problems.filter((problem) => problem.code === "intent_question_missing")).toEqual([
      { code: "intent_question_missing", decision_id: "d-intent-q2" },
      { code: "intent_question_missing", decision_id: "d-intent-q3" },
    ]);
  });
});

describe("lintDecisions: the link rule", () => {
  const linksOf = (...ids: string[]): DecisionLinks => ({ linkedDecisionIds: () => new Set(ids) });
  const state = (): DecisionState => stateOf([interfaceRecord(), latencyRecord(), record("d-retry")]);

  it("skips the rule when no links are injected", () => {
    expect(codes(lintDecisions(state(), CLEAN_LEAK, []))).not.toContain("unlinked");
  });

  it("with an empty link set, flags every resolved non-quantitative decision and not the quantitative one", () => {
    const problems = lintDecisions(state(), CLEAN_LEAK, [], linksOf());
    expect(problems.filter((problem) => problem.code === "unlinked").map((problem) => problem.decision_id)).toEqual([
      "d-interface",
      "d-retry",
    ]);
  });

  it("stops flagging a decision once it is linked", () => {
    const problems = lintDecisions(state(), CLEAN_LEAK, [], linksOf("d-interface", "d-retry"));
    expect(codes(problems)).not.toContain("unlinked");
  });
});

describe("scenarioLinkCoverage", () => {
  it("lists resolved non-quantitative ids as unlinked and resolved quantitative ids as not_run", () => {
    const state = stateOf([interfaceRecord(), latencyRecord(), record("d-retry")]);
    expect(scenarioLinkCoverage(state, new Set(["d-retry"]))).toEqual({
      unlinked: ["d-interface"],
      not_run: ["d-latency"],
    });
  });

  it("ignores decisions that are not resolved, and links to ids that do not exist", () => {
    const state = stateOf([
      interfaceRecord(),
      record("d-open", { status: "open", resolution: null, closed_seq: null }),
      record("d-na", { status: "na", resolution: null, na: { rationale: "Not relevant.", by: HUMAN, at: AT } }),
      latencyRecord({ status: "open", resolution: null, closed_seq: null }),
    ]);
    expect(scenarioLinkCoverage(state, new Set(["d-interface", "d-ghost"]))).toEqual({ unlinked: [], not_run: [] });
  });
});
