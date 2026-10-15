import { describe, expect, it } from "vitest";
import { lintDecisions } from "../../src/decision/lint.js";
import type { LeakContext } from "../../src/decision/leak-lint.js";
import type { DecisionRecord, DecisionState } from "../../src/decision/types.js";
import type { EffectiveScenario } from "../../src/scenario/events.js";
import { contradictions, lintScenarioSet, vaultDecisionLinks } from "../../src/scenario/lint.js";
import type { LintInput } from "../../src/scenario/lint.js";
import { scenarioRef } from "../../src/scenario/types.js";
import type { AuthorStamp, Expect, ScenarioStatus, ScenarioStep, StoredScenario } from "../../src/scenario/types.js";

const WORK = "w-0123456789ab";
const hex = (n: number): string => n.toString(16).padStart(32, "0");
const idOf = (n: number): string => `s-${hex(n)}`;
const canaryOf = (n: number): string => `omf-canary-${hex(n)}`;
const refOf = (n: number): string => scenarioRef(idOf(n));

const AUTHOR: AuthorStamp = { vendor: "command", model: "stub", at: "2026-10-14T00:00:00.000Z", isolation: "host_command" };
const CLEAN_LEAK: LeakContext = { terms: { phrases: [] }, targetValues: [], targetNumbers: [], measuredNumbers: [] };

let seq = 1;
function record(id: string, over: Partial<DecisionRecord> = {}): DecisionRecord {
  seq += 1;
  return {
    id,
    class: "other",
    question: "Should it work?",
    qas: null,
    response_measure: null,
    status: "resolved",
    resolution: { choice: "Yes", rationale: "Needed", rejected: [], by: "human:dev@example.com", at: AUTHOR.at },
    deferral: null,
    interface: null,
    na: null,
    added_by: "omf",
    added_seq: seq,
    closed_seq: seq,
    measure_seq: null,
    ...over,
  };
}

const STATE: DecisionState = {
  scope: { goal_id: "g-hello", work_id: WORK },
  decisions: [
    record("d-add"),
    record("d-other"),
    record("d-open", { status: "open", resolution: null, closed_seq: null }),
    record("d-defer", { status: "deferred", resolution: null }),
    record("d-na", { status: "na", resolution: null }),
    record("d-latency", {
      class: "latency",
      response_measure: { metric: "request time", op: "<=", threshold: 250, unit: "ms", percentile: 95, window: null },
    }),
  ],
  anomalies: [],
};

/** A step whose note starts with scenario n's canary, as OMF stamps it at intake. */
function step(n: number, argv: string[], expectOver: Partial<Expect> = {}, stdin = ""): ScenarioStep {
  const expectation: Expect = { exit_code: 0, stdout_matches: null, json_path: null, note: `${canaryOf(n)} expectation`, ...expectOver };
  return { invoke: { argv, stdin }, expect: expectation };
}

function scenario(n: number, over: Partial<StoredScenario> = {}): StoredScenario {
  return {
    schema_version: 1,
    scenario_id: idOf(n),
    work_id: WORK,
    author: AUTHOR,
    decision_refs: ["d-add"],
    kind: "behavior",
    split: "train",
    interface: "cli",
    steps: [step(n, ["add", "x"])],
    canary: canaryOf(n),
    ...over,
  };
}

/** A canary no program can pass: the exact text is not JSON, but the step also demands a json_path value. */
function canary(n: number, over: Partial<StoredScenario> = {}): StoredScenario {
  const unsatisfiable = step(n, ["show"], { stdout_matches: { kind: "exact", text: "not json\n" }, json_path: { "$.ok": true } });
  return scenario(n, { kind: "contradiction_canary", decision_refs: [], steps: [unsatisfiable], ...over });
}

const eff = (scenarioValue: StoredScenario, status: ScenarioStatus = "active"): EffectiveScenario => ({ scenario: scenarioValue, status });

function lint(items: EffectiveScenario[], over: Partial<LintInput> = {}) {
  return lintScenarioSet({ scenarios: items, state: STATE, workId: WORK, sealedAuthor: AUTHOR, ...over });
}
const codes = (items: EffectiveScenario[], over: Partial<LintInput> = {}): string[] => lint(items, over).map((p) => p.code);

describe("lintScenarioSet: set-level identity", () => {
  it("accepts a clean behavior scenario and a clean canary", () => {
    expect(lint([eff(scenario(1)), eff(canary(2))])).toEqual([]);
  });

  it("flags a file that is not a stored_scenario (a status key is not allowed in a file)", () => {
    const withStatus = { ...scenario(1), status: "retired" } as unknown as StoredScenario;
    expect(lint([eff(withStatus)])).toEqual([{ code: "schema_invalid", scenario_ref: refOf(1) }]);
  });

  it("flags a foreign work id, a different author and a repeated id", () => {
    expect(codes([eff(scenario(1, { work_id: "w-aaaaaaaaaaaa" }))])).toEqual(["work_mismatch"]);
    expect(codes([eff(scenario(1, { author: { ...AUTHOR, model: "other" } }))])).toEqual(["author_mismatch"]);
    expect(codes([eff(scenario(1)), eff(scenario(1, { canary: canaryOf(1) }))])).toEqual(["duplicate_id"]);
  });

  it("ignores retired and contaminated scenarios, even broken ones", () => {
    const broken = (n: number) => scenario(n, { decision_refs: ["d-missing"] });
    expect(lint([eff(broken(1), "retired"), eff(broken(2), "contaminated")])).toEqual([]);
  });
});

describe("lintScenarioSet: decision references", () => {
  it("requires at least one reference on a behavior scenario, but not on a canary", () => {
    expect(lint([eff(scenario(1, { decision_refs: [] }))])).toEqual([{ code: "no_decision_ref", scenario_ref: refOf(1) }]);
    expect(lint([eff(canary(2))])).toEqual([]);
  });

  it.each([
    ["d-missing", "unknown_decision_ref"],
    ["d-open", "decision_not_resolved"],
    ["d-defer", "decision_not_resolved"],
    ["d-na", "decision_not_resolved"],
    ["d-latency", "decision_quantitative"],
  ])("reference %s is a %s problem and names the decision", (ref, code) => {
    expect(lint([eff(scenario(1, { decision_refs: [ref] }))])).toEqual([{ code, scenario_ref: refOf(1), decision_id: ref }]);
  });
});

describe("lintScenarioSet: expectations and canary placement", () => {
  it("flags a step that asserts nothing", () => {
    const empty = scenario(1, { steps: [step(1, ["add", "x"], { exit_code: null })] });
    expect(lint([eff(empty)])).toEqual([{ code: "expect_empty", scenario_ref: refOf(1) }]);
  });

  it("flags the canary inside an argv element or stdin, and a note that does not start with it", () => {
    const inArgv = scenario(1, { steps: [step(1, ["add", canaryOf(1)])] });
    const inStdin = scenario(2, { steps: [step(2, ["add", "x"], {}, `line ${canaryOf(2)}`)] });
    const noPrefix = scenario(3, { steps: [step(3, ["add", "x"], { note: "no canary here" })] });
    expect(codes([eff(inArgv)])).toEqual(["canary_in_invoke"]);
    expect(codes([eff(inStdin)])).toEqual(["canary_in_invoke"]);
    expect(codes([eff(noPrefix)])).toEqual(["canary_missing_from_note"]);
  });
});

describe("lintScenarioSet: canary_satisfiable", () => {
  const exact = (text: string) => ({ kind: "exact", text }) as const;
  it.each([
    ["an anchored-only canary", [{ stdout_matches: { kind: "anchored", pattern: "^ok$" } }]],
    ["an exact text with only an exit code", [{ stdout_matches: exact("ok\n") }]],
    ["an exact JSON text that satisfies its own json_path", [{ stdout_matches: exact('{"ok":true}'), json_path: { "$.ok": true } }]],
  ] as const)("refuses %s", (_name, expectOver) => {
    const satisfiable = canary(1, { steps: [step(1, ["show"], expectOver[0] as Partial<Expect>)] });
    expect(lint([eff(satisfiable)])).toEqual([{ code: "canary_satisfiable", scenario_ref: refOf(1) }]);
  });

  it("accepts a canary whose exact JSON text contradicts its own json_path", () => {
    const disagree = step(1, ["show"], { stdout_matches: exact('{"ok":false}'), json_path: { "$.ok": true } });
    expect(lint([eff(canary(1, { steps: [disagree] }))])).toEqual([]);
  });

  it("accepts a canary when any one of its steps is unsatisfiable", () => {
    const fine = step(1, ["add", "x"]);
    const impossible = step(1, ["show"], { stdout_matches: exact("nope"), json_path: { "$.a": 1 } });
    expect(lint([eff(canary(1, { steps: [fine, impossible] }))])).toEqual([]);
  });
});

describe("contradictions", () => {
  const demand = (n: number, steps: ScenarioStep[]): EffectiveScenario => eff(scenario(n, { steps }));
  const exactText = (text: string): Partial<Expect> => ({ stdout_matches: { kind: "exact", text } });

  it("pairs two scenarios that share an invoke and demand different exit codes", () => {
    const a = demand(1, [step(1, ["list"], { exit_code: 0 })]);
    const b = demand(2, [step(2, ["list"], { exit_code: 1 })]);
    expect(contradictions([a, b])).toEqual([{ scenario_ref_a: refOf(1), scenario_ref_b: refOf(2) }]);
  });

  it("pairs two scenarios that share a prefix and demand different exact stdout", () => {
    const a = demand(1, [step(1, ["add", "x"]), step(1, ["list"], exactText("x\n"))]);
    const b = demand(2, [step(2, ["add", "x"]), step(2, ["list"], exactText("y\n"))]);
    expect(contradictions([a, b])).toEqual([{ scenario_ref_a: refOf(1), scenario_ref_b: refOf(2) }]);
  });

  it("does not compare a step that follows different prior steps (state is shared inside a scenario)", () => {
    const afterAdd = demand(1, [step(1, ["add", "x"]), step(1, ["list"], exactText("x\n"))]);
    const bare = demand(2, [step(2, ["list"], exactText("\n"))]);
    expect(contradictions([afterAdd, bare])).toEqual([]);
  });

  it("does not pair equal demands, an unset side, canaries or inactive scenarios", () => {
    const same = [demand(1, [step(1, ["list"])]), demand(2, [step(2, ["list"])])];
    const unset = [demand(3, [step(3, ["list"], { exit_code: 0 })]), demand(4, [step(4, ["list"], { exit_code: null, stdout_matches: { kind: "anchored", pattern: "^$" } })])];
    const canaries = [eff(canary(5)), eff(canary(6, { steps: [step(6, ["show"], { exit_code: 1 })] }))];
    const retired = [demand(7, [step(7, ["list"], { exit_code: 0 })]), eff(scenario(8, { steps: [step(8, ["list"], { exit_code: 1 })] }), "retired")];
    for (const group of [same, unset, canaries, retired]) expect(contradictions(group)).toEqual([]);
  });

  it("is reported by lintScenarioSet once per pair, on the earlier scenario", () => {
    const a = demand(1, [step(1, ["list"], { exit_code: 0 })]);
    const b = demand(2, [step(2, ["list"], { exit_code: 1 })]);
    expect(lint([a, b])).toEqual([{ code: "contradiction", scenario_ref: refOf(1) }]);
  });
});

describe("problems carry references, not text", () => {
  it("never contain argv, stdin, a pattern or a canary", () => {
    const leaky = scenario(1, { decision_refs: ["d-missing"], steps: [step(1, ["add", "distinctive-zq9"], { exit_code: null }, `stdin ${canaryOf(1)}`)] });
    const text = JSON.stringify(lint([eff(leaky)]));
    expect(text).not.toContain("distinctive-zq9");
    expect(text).not.toContain("omf-canary-");
    expect(text).not.toContain("stdin");
  });
});

describe("vaultDecisionLinks", () => {
  it("counts active behavior scenarios only and plugs into the M3a link rule", () => {
    const covers = scenario(1, { decision_refs: ["d-add"] });
    const canaryNamesOther = canary(2, { decision_refs: ["d-other"] });
    const retiredNamesOther = scenario(3, { decision_refs: ["d-other"] });
    const links = vaultDecisionLinks([eff(covers), eff(canaryNamesOther), eff(retiredNamesOther, "retired")]);
    expect([...links.linkedDecisionIds()]).toEqual(["d-add"]);

    const unlinked = lintDecisions(STATE, CLEAN_LEAK, [], links).filter((p) => p.code === "unlinked");
    expect(unlinked).toEqual([{ code: "unlinked", decision_id: "d-other" }]);
  });
});
