import { describe, expect, it } from "vitest";
import { CANARY, canaryHits } from "../helpers/canary.js";
import {
  type ClassifierInput,
  type ClassifierRule,
  type EvidenceInputs,
  classifyOutcome,
  emptyEvidenceInputs,
  resetRoundScopedInputs,
  toOutcomeInput,
} from "../../src/work/classify.js";
import { aggregateGates } from "../../src/work/gates.js";
import {
  NOT_RUN,
  ROUND_SCOPED_INPUTS,
  STATION_IDS,
  type StationId,
  type StationStatus,
} from "../../src/work/line-types.js";
import { type Disposition, type WOutcome, dispositionOf } from "../../src/work/outcome.js";
import type { ReasonCode, Recommendation } from "../../src/work/w-events.js";

/** Every input produced and clean: the only inputs from which a success can come. */
function cleanInputs(): EvidenceInputs {
  return {
    audit: { canary_hits: 0, tests_edited: false, prove_test: "pass", judge_config_touched: false },
    sealed: { train: { pass: 4, total: 4, flaky: 0 }, test: { pass: 2, total: 2 } },
    isolation_level: "L2",
    high_risk_paths_touched: [],
    noise_check: "ok",
    gate_line: "OMF_GATES fast=pass",
    plan_summary: "Plan.",
    implementer_notes: "Notes.",
  };
}

describe("evidence inputs (a field nobody produced never reads as passed)", () => {
  it("starts with every input not run and the isolation level unmeasured", () => {
    expect(emptyEvidenceInputs()).toEqual({
      audit: { canary_hits: NOT_RUN, tests_edited: NOT_RUN, prove_test: NOT_RUN, judge_config_touched: NOT_RUN },
      sealed: { train: NOT_RUN, test: NOT_RUN },
      isolation_level: "unmeasured",
      high_risk_paths_touched: NOT_RUN,
      noise_check: NOT_RUN,
      gate_line: NOT_RUN,
      plan_summary: NOT_RUN,
      implementer_notes: NOT_RUN,
    });
  });

  it("hands out a fresh object every time", () => {
    const first = emptyEvidenceInputs();
    first.audit.canary_hits = 3;
    expect(emptyEvidenceInputs().audit.canary_hits).toBe(NOT_RUN);
  });

  it("scopes every field to a round except the isolation level (M3b2-D5)", () => {
    expect([...ROUND_SCOPED_INPUTS].sort()).toEqual([
      "audit",
      "gate_line",
      "high_risk_paths_touched",
      "implementer_notes",
      "noise_check",
      "plan_summary",
      "sealed",
    ]);
    // A new field must be placed on one side or the other: this fails until it is.
    expect(new Set([...ROUND_SCOPED_INPUTS, "isolation_level"])).toEqual(new Set(Object.keys(emptyEvidenceInputs())));
  });

  it("resets exactly the round-scoped fields, in place, and keeps the run-wide isolation level", () => {
    const inputs = cleanInputs();
    const same = inputs;
    resetRoundScopedInputs(inputs);
    expect(inputs).toBe(same);
    expect({ ...inputs, isolation_level: "unmeasured" }).toEqual(emptyEvidenceInputs());
    expect(inputs.isolation_level).toBe("L2");
  });
});

const PASS_ALL = aggregateGates({ "GATE-1": "pass", "GATE-2": "pass", "GATE-3": "pass", "GATE-4": "pass" });

function stationsAll(status: StationStatus = "ok"): Record<StationId, StationStatus> {
  return Object.fromEntries(STATION_IDS.map((id) => [id, status])) as Record<StationId, StationStatus>;
}

/** A line that completed with every gate passed, every station ok and every input clean: the one success. */
function base(over: Partial<ClassifierInput> = {}): ClassifierInput {
  return {
    stop: { kind: "none" },
    stations: stationsAll(),
    gates: PASS_ALL,
    inputs: cleanInputs(),
    decisions_unmeasured: [],
    gate4_warnings: [],
    injected_gates: [],
    declared_level: "L2",
    ...over,
  };
}

interface Row {
  name: string;
  input: ClassifierInput;
  outcome: WOutcome;
  exhausted: boolean;
  reason_code: ReasonCode | null;
  recommendation: Recommendation;
  rule: ClassifierRule;
  action: Disposition["action"];
}

const flaggedAudit = (): EvidenceInputs => ({ ...cleanInputs(), audit: { ...cleanInputs().audit, canary_hits: 2 } });

/** One case per row of the skeleton table (section 4.5) that does not need the audit or sealed rows (Part C). */
const ROWS: Row[] = [
  {
    name: "1a a station error",
    input: base({ stop: { kind: "station", station: "S3", result: "error", reason_code: "station_error" } }),
    outcome: "blocked",
    exhausted: false,
    reason_code: "station_error",
    recommendation: "human_needed",
    rule: "station_error",
    action: "park",
  },
  {
    name: "1b a station asks for a person",
    input: base({ stop: { kind: "station", station: "S1", result: "manual", reason_code: "manual_required" } }),
    outcome: "manual",
    exhausted: false,
    reason_code: "manual_required",
    recommendation: "human_needed",
    rule: "station_manual",
    action: "park",
  },
  {
    name: "1c a station is blocked (the station's own code)",
    input: base({ stop: { kind: "station", station: "S4", result: "blocked", reason_code: "infra_failure" } }),
    outcome: "blocked",
    exhausted: false,
    reason_code: "infra_failure",
    recommendation: "human_needed",
    rule: "station_blocked",
    action: "park",
  },
  {
    name: "2 a gate was not run",
    input: base({
      stop: { kind: "gate", gate: "GATE-2", verdict: "not_run", reasons: ["not_implemented"] },
      gates: aggregateGates({ "GATE-1": "pass", "GATE-2": "not_run" }),
    }),
    outcome: "blocked",
    exhausted: false,
    reason_code: "gate_not_run",
    recommendation: "human_needed",
    rule: "gate_not_run",
    action: "park",
  },
  {
    name: "3 GATE-1 failed",
    input: base({ stop: { kind: "gate", gate: "GATE-1", verdict: "fail", reasons: ["j2_open"] } }),
    outcome: "blocked",
    exhausted: false,
    reason_code: "j2_open",
    recommendation: "human_needed",
    rule: "gate1_open",
    action: "park",
  },
  {
    name: "3b GATE-2 failed with a stop at J2",
    input: base({
      stop: { kind: "gate", gate: "GATE-2", verdict: "fail", reasons: ["gate1_not_passing"], stop: "J2" },
    }),
    outcome: "blocked",
    exhausted: false,
    reason_code: "j2_open",
    recommendation: "human_needed",
    rule: "gate2_stop",
    action: "park",
  },
  {
    name: "3b GATE-2 failed with a stop at J3",
    input: base({
      stop: { kind: "gate", gate: "GATE-2", verdict: "fail", reasons: ["exposure_exhausted"], stop: "J3" },
    }),
    outcome: "blocked",
    exhausted: false,
    reason_code: "scenarios_need_review",
    recommendation: "human_needed",
    rule: "gate2_stop",
    action: "park",
  },
  {
    name: "3b GATE-2 failed with a stop at J7",
    input: base({ stop: { kind: "gate", gate: "GATE-2", verdict: "fail", reasons: ["ledger_anomaly"], stop: "J7" } }),
    outcome: "blocked",
    exhausted: false,
    reason_code: "gate_blocked",
    recommendation: "human_needed",
    rule: "gate2_stop",
    action: "park",
  },
  {
    name: "2 GATE-2 not_run stays row 2 even with a stop on it",
    input: base({ stop: { kind: "gate", gate: "GATE-2", verdict: "not_run", reasons: ["gate_error"], stop: "J7" } }),
    outcome: "blocked",
    exhausted: false,
    reason_code: "gate_not_run",
    recommendation: "human_needed",
    rule: "gate_not_run",
    action: "park",
  },
  {
    name: "4a GATE-3 failed with an audit flag after an implementation",
    input: base({
      stop: { kind: "gate", gate: "GATE-3", verdict: "fail", reasons: ["canary_hit"] },
      inputs: flaggedAudit(),
    }),
    outcome: "flawed",
    exhausted: false,
    reason_code: "audit_flag",
    recommendation: "not_recommended",
    rule: "gate3_flawed",
    action: "submit",
  },
  {
    name: "4b GATE-3 failed with a clean audit",
    input: base({ stop: { kind: "gate", gate: "GATE-3", verdict: "fail", reasons: ["misconfigured"] } }),
    outcome: "blocked",
    exhausted: false,
    reason_code: "gate_blocked",
    recommendation: "human_needed",
    rule: "gate3_blocked",
    action: "park",
  },
  {
    name: "4b GATE-3 failed with an audit flag but no implementation behind it",
    input: base({
      stop: { kind: "gate", gate: "GATE-3", verdict: "fail", reasons: ["canary_hit"] },
      inputs: flaggedAudit(),
      stations: { ...stationsAll(), S3: "not_run" },
    }),
    outcome: "blocked",
    exhausted: false,
    reason_code: "gate_blocked",
    recommendation: "human_needed",
    rule: "gate3_blocked",
    action: "park",
  },
  {
    name: "5a GATE-4 integrity failure",
    input: base({ stop: { kind: "gate4", severity: "integrity", reasons: ["ledger_anomaly"], round: 1 } }),
    outcome: "blocked",
    exhausted: false,
    reason_code: "gate_blocked",
    recommendation: "human_needed",
    rule: "gate4_integrity",
    action: "park",
  },
  {
    name: "5b GATE-4 re-entry loop",
    input: base({ stop: { kind: "gate4", severity: "hard", reasons: ["reentry_loop"], round: 0 } }),
    outcome: "blocked",
    exhausted: false,
    reason_code: "reentry_loop",
    recommendation: "human_needed",
    rule: "gate4_reentry",
    action: "park",
  },
  {
    name: "5c GATE-4 hard in round 0 (the S2/GATE-2 loop)",
    input: base({ stop: { kind: "gate4", severity: "hard", reasons: ["visit_cap"], round: 0 } }),
    outcome: "blocked",
    exhausted: false,
    reason_code: "gate2_exhausted",
    recommendation: "human_needed",
    rule: "gate4_hard_round0",
    action: "park",
  },
  {
    name: "5d a stall in round 2 is flawed and exhausted",
    input: base({ stop: { kind: "gate4", severity: "hard", reasons: ["stalled"], round: 2 } }),
    outcome: "flawed",
    exhausted: true,
    reason_code: "stalled",
    recommendation: "not_recommended",
    rule: "gate4_hard",
    action: "fail",
  },
  {
    name: "5d the total visit cap in round 1 is a visit_cap",
    input: base({ stop: { kind: "gate4", severity: "hard", reasons: ["total_visit_cap"], round: 1 } }),
    outcome: "flawed",
    exhausted: true,
    reason_code: "visit_cap",
    recommendation: "not_recommended",
    rule: "gate4_hard",
    action: "fail",
  },
  {
    name: "5e rounds exhausted at line entry parks the item",
    input: base({ stop: { kind: "gate4", severity: "soft", reasons: ["rounds_exhausted"], round: 0 } }),
    outcome: "blocked",
    exhausted: false,
    reason_code: "budget_exhausted",
    recommendation: "human_needed",
    rule: "gate4_soft",
    action: "park",
  },
  {
    name: "5e spend exhausted in round 2 parks the item",
    input: base({ stop: { kind: "gate4", severity: "soft", reasons: ["spend_exhausted"], round: 2 } }),
    outcome: "blocked",
    exhausted: false,
    reason_code: "budget_exhausted",
    recommendation: "human_needed",
    rule: "gate4_soft",
    action: "park",
  },
  {
    name: "6a a completed line with a skipped station",
    input: base({ stations: { ...stationsAll(), S5: "skipped" } }),
    outcome: "blocked",
    exhausted: false,
    reason_code: "station_skipped",
    recommendation: "human_needed",
    rule: "station_skipped",
    action: "park",
  },
  {
    name: "6b a completed line whose gate aggregate is not a pass",
    input: base({ gates: aggregateGates({ "GATE-1": "pass", "GATE-2": "pass" }) }),
    outcome: "blocked",
    exhausted: false,
    reason_code: "gate_not_run",
    recommendation: "human_needed",
    rule: "gate_not_run",
    action: "park",
  },
  {
    name: "8 everything produced and clean",
    input: base(),
    outcome: "success",
    exhausted: false,
    reason_code: null,
    recommendation: "merge_recommended",
    rule: "success",
    action: "submit",
  },
];

describe("classifyOutcome (first matching row wins; success is the last row)", () => {
  it.each(ROWS)("$name", (row) => {
    const c = classifyOutcome(row.input);
    expect(c).toMatchObject({
      outcome: row.outcome,
      exhausted: row.exhausted,
      reason_code: row.reason_code,
      recommendation: row.recommendation,
      rule: row.rule,
    });
    // Every row is accepted by the M3b1 outcome table, with the action the row promises.
    const disposition = dispositionOf(toOutcomeInput(c));
    expect(disposition.action).toBe(row.action);
    if (disposition.action === "submit") expect(disposition.recommendation).toBe(row.recommendation);
  });

  it("a station error wins over a gate verdict and an incomplete input bag (the stop decides first)", () => {
    const c = classifyOutcome(
      base({
        stop: { kind: "station", station: "S2", result: "error", reason_code: "station_error" },
        inputs: emptyEvidenceInputs(),
        gates: aggregateGates({}),
      }),
    );
    expect(c.rule).toBe("station_error");
  });
});

describe("a required input that nobody produced is blocked evidence_incomplete (6c, E7a)", () => {
  const MISSING: [string, (i: EvidenceInputs) => void][] = [
    [
      "audit.canary_hits",
      (i) => {
        i.audit.canary_hits = NOT_RUN;
      },
    ],
    [
      "audit.tests_edited",
      (i) => {
        i.audit.tests_edited = NOT_RUN;
      },
    ],
    [
      "audit.prove_test",
      (i) => {
        i.audit.prove_test = NOT_RUN;
      },
    ],
    [
      "audit.judge_config_touched",
      (i) => {
        i.audit.judge_config_touched = NOT_RUN;
      },
    ],
    [
      "sealed.train",
      (i) => {
        i.sealed.train = NOT_RUN;
      },
    ],
    [
      "sealed.test",
      (i) => {
        i.sealed.test = NOT_RUN;
      },
    ],
    [
      "sealed.train with a total of 0",
      (i) => {
        i.sealed.train = { pass: 0, total: 0, flaky: 0 };
      },
    ],
    [
      "sealed.test with a total of 0",
      (i) => {
        i.sealed.test = { pass: 0, total: 0 };
      },
    ],
    [
      "gate_line",
      (i) => {
        i.gate_line = NOT_RUN;
      },
    ],
    [
      "isolation_level unmeasured",
      (i) => {
        i.isolation_level = "unmeasured";
      },
    ],
    [
      "isolation_level below the declared L2",
      (i) => {
        i.isolation_level = "L1";
      },
    ],
  ];

  it.each(MISSING)("%s", (_name, remove) => {
    const inputs = cleanInputs();
    remove(inputs);
    const c = classifyOutcome(base({ inputs }));
    expect(c).toMatchObject({
      outcome: "blocked",
      exhausted: false,
      reason_code: "evidence_incomplete",
      rule: "evidence_incomplete",
    });
    expect(dispositionOf(toOutcomeInput(c)).action).toBe("park");
  });

  it("every input not run on a completed line is blocked, and lists what it did not verify", () => {
    const c = classifyOutcome(base({ inputs: emptyEvidenceInputs() }));
    expect(c.rule).toBe("evidence_incomplete");
    expect(c.recommendation).toBe("human_needed");
    expect(c.unverified_areas).toEqual([
      { code: "noise_check_not_run", decision_id: null },
      { code: "high_risk_paths_not_run", decision_id: null },
    ]);
  });

  it("an isolation level at or above the declared one is enough", () => {
    const inputs = cleanInputs();
    inputs.isolation_level = "L3";
    expect(classifyOutcome(base({ inputs })).outcome).toBe("success");
  });
});

describe("success carries merge_recommended only with nothing unverified (M3b2-D9)", () => {
  const AREAS: [string, Partial<ClassifierInput>, { code: string; decision_id: string | null }][] = [
    [
      "an unmeasured quantitative decision",
      { decisions_unmeasured: ["d-1"] },
      { code: "decision_unmeasured", decision_id: "d-1" },
    ],
    [
      "unknown model spend",
      { gate4_warnings: ["spend_unverifiable"] },
      { code: "model_spend_unverifiable", decision_id: null },
    ],
    ["an injected gate", { injected_gates: ["GATE-2"] }, { code: "injected_gate", decision_id: null }],
  ];

  it("a clean line is merge_recommended and needs no human", () => {
    const c = classifyOutcome(base());
    expect(c.recommendation).toBe("merge_recommended");
    expect(c.unverified_areas).toEqual([]);
    expect(toOutcomeInput(c)).toEqual({ outcome: "success", exhausted: false, reason_code: null, human_needed: false });
  });

  it.each(AREAS)("%s makes the success human_needed", (_name, over, area) => {
    const c = classifyOutcome(base(over));
    expect(c).toMatchObject({ outcome: "success", recommendation: "human_needed", rule: "success" });
    expect(c.unverified_areas).toEqual([area]);
    expect(toOutcomeInput(c).human_needed).toBe(true);
    expect(dispositionOf(toOutcomeInput(c))).toMatchObject({ action: "submit", recommendation: "human_needed" });
  });

  const INPUT_AREAS: [string, (i: EvidenceInputs) => void, { code: string; decision_id: null }][] = [
    [
      "noise_check not run",
      (i) => {
        i.noise_check = NOT_RUN;
      },
      { code: "noise_check_not_run", decision_id: null },
    ],
    [
      "noise_check not_evaluated",
      (i) => {
        i.noise_check = "not_evaluated";
      },
      { code: "noise_check_not_evaluated", decision_id: null },
    ],
    [
      "high-risk paths not run",
      (i) => {
        i.high_risk_paths_touched = NOT_RUN;
      },
      { code: "high_risk_paths_not_run", decision_id: null },
    ],
    [
      "high-risk paths touched",
      (i) => {
        i.high_risk_paths_touched = ["src/auth/login.ts"];
      },
      { code: "high_risk_paths_touched", decision_id: null },
    ],
  ];

  it.each(INPUT_AREAS)("%s is an unverified area, not a failure", (_name, change, area) => {
    const inputs = cleanInputs();
    change(inputs);
    const c = classifyOutcome(base({ inputs }));
    expect(c).toMatchObject({ outcome: "success", recommendation: "human_needed" });
    expect(c.unverified_areas).toEqual([area]);
  });

  it("untrusted text that was not produced is not evidence and changes nothing", () => {
    const inputs = cleanInputs();
    inputs.plan_summary = NOT_RUN;
    inputs.implementer_notes = NOT_RUN;
    expect(classifyOutcome(base({ inputs })).recommendation).toBe("merge_recommended");
  });

  it("a Classification holds ids and codes only: untrusted text and metric names never reach it", () => {
    const inputs = cleanInputs();
    inputs.plan_summary = `plan ${CANARY.metricId} ${CANARY.reading}`;
    inputs.implementer_notes = `notes ${CANARY.target}`;
    inputs.gate_line = `OMF_GATES ${CANARY.metricId}`;
    const c = classifyOutcome(base({ inputs, decisions_unmeasured: ["d-9"] }));
    expect(canaryHits(JSON.stringify(c))).toEqual([]);
  });
});

describe("quality rows of a completed line (7a to 7d) are flawed and not recommended", () => {
  const QUALITY: [string, (i: EvidenceInputs) => void, ReasonCode][] = [
    [
      "7a a canary hit",
      (i) => {
        i.audit.canary_hits = 1;
      },
      "audit_flag",
    ],
    [
      "7a an edited test",
      (i) => {
        i.audit.tests_edited = true;
      },
      "audit_flag",
    ],
    [
      "7a a failed prove_test",
      (i) => {
        i.audit.prove_test = "fail";
      },
      "audit_flag",
    ],
    [
      "7a a touched judge config",
      (i) => {
        i.audit.judge_config_touched = true;
      },
      "audit_flag",
    ],
    [
      "7b a failed train scenario",
      (i) => {
        i.sealed.train = { pass: 3, total: 4, flaky: 0 };
      },
      "sealed_failed",
    ],
    [
      "7b a failed test scenario",
      (i) => {
        i.sealed.test = { pass: 1, total: 2 };
      },
      "sealed_failed",
    ],
    [
      "7c a flaky scenario even though all passed",
      (i) => {
        i.sealed.train = { pass: 4, total: 4, flaky: 1 };
      },
      "flaky_scenario",
    ],
    [
      "7d a gain within run-to-run variance",
      (i) => {
        i.noise_check = "within_variance";
      },
      "within_variance",
    ],
  ];

  it.each(QUALITY)("%s", (_name, change, reason) => {
    const inputs = cleanInputs();
    change(inputs);
    const c = classifyOutcome(base({ inputs }));
    expect(c).toMatchObject({
      outcome: "flawed",
      exhausted: false,
      reason_code: reason,
      recommendation: "not_recommended",
      rule: reason,
    });
    expect(dispositionOf(toOutcomeInput(c))).toMatchObject({ action: "submit", recommendation: "not_recommended" });
  });

  it("checks the rows in order: audit, then flaky, then sealed, then variance", () => {
    const inputs = cleanInputs();
    inputs.noise_check = "within_variance";
    inputs.sealed.train = { pass: 2, total: 4, flaky: 2 };
    expect(classifyOutcome(base({ inputs })).rule).toBe("flaky_scenario");
    inputs.sealed.train = { pass: 3, total: 4, flaky: 0 };
    expect(classifyOutcome(base({ inputs })).rule).toBe("sealed_failed");
    inputs.audit.tests_edited = true;
    expect(classifyOutcome(base({ inputs })).rule).toBe("audit_flag");
  });

  it("incomplete evidence is checked before quality: a flag beside a missing input is blocked", () => {
    const inputs = cleanInputs();
    inputs.audit.tests_edited = true;
    inputs.gate_line = NOT_RUN;
    expect(classifyOutcome(base({ inputs })).rule).toBe("evidence_incomplete");
  });
});

/** A small seeded generator, so the whole-table check is the same on every machine. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length)] as T;
}

function randomInput(next: () => number): ClassifierInput {
  const stops: ClassifierInput["stop"][] = [
    { kind: "none" },
    { kind: "none" },
    { kind: "none" },
    { kind: "none" },
    { kind: "station", station: "S3", result: "error", reason_code: "station_error" },
    { kind: "station", station: "S1", result: "manual", reason_code: "manual_required" },
    { kind: "station", station: "S4", result: "blocked", reason_code: "infra_failure" },
    { kind: "gate", gate: "GATE-1", verdict: "fail", reasons: ["j2_open"] },
    { kind: "gate", gate: "GATE-2", verdict: "not_run", reasons: ["not_implemented"] },
    { kind: "gate", gate: "GATE-3", verdict: "fail", reasons: ["canary_hit"] },
    { kind: "gate4", severity: "integrity", reasons: ["ledger_anomaly"], round: 1 },
    { kind: "gate4", severity: "hard", reasons: ["reentry_loop"], round: 0 },
    { kind: "gate4", severity: "hard", reasons: ["visit_cap"], round: 0 },
    { kind: "gate4", severity: "hard", reasons: ["stalled"], round: 2 },
    { kind: "gate4", severity: "soft", reasons: ["spend_exhausted"], round: 1 },
  ];
  const inputs = cleanInputs();
  const fault = (p: number): boolean => next() < p;
  if (fault(0.1)) inputs.audit.canary_hits = pick(next, [NOT_RUN, 0, 2]);
  if (fault(0.1)) inputs.audit.tests_edited = pick(next, [NOT_RUN, true]);
  if (fault(0.1)) inputs.audit.prove_test = pick(next, [NOT_RUN, "fail"] as const);
  if (fault(0.1)) inputs.audit.judge_config_touched = pick(next, [NOT_RUN, true]);
  if (fault(0.1))
    inputs.sealed.train = pick(next, [
      NOT_RUN,
      { pass: 0, total: 0, flaky: 0 },
      { pass: 1, total: 4, flaky: 0 },
      { pass: 4, total: 4, flaky: 1 },
    ]);
  if (fault(0.1)) inputs.sealed.test = pick(next, [NOT_RUN, { pass: 0, total: 0 }, { pass: 1, total: 2 }]);
  if (fault(0.1)) inputs.isolation_level = pick(next, ["unmeasured", "L1", "L3"] as const);
  if (fault(0.1)) inputs.gate_line = NOT_RUN;
  if (fault(0.1)) inputs.noise_check = pick(next, [NOT_RUN, "within_variance", "not_evaluated"] as const);
  if (fault(0.1)) inputs.high_risk_paths_touched = pick(next, [NOT_RUN, ["src/a.ts"]]);
  const stations = stationsAll();
  for (const id of STATION_IDS)
    if (fault(0.03)) stations[id] = pick(next, ["rework", "skipped", "blocked", "manual", "error", "not_run"] as const);
  const gates = aggregateGates({
    "GATE-1": fault(0.05) ? "fail" : "pass",
    "GATE-2": fault(0.05) ? "not_run" : "pass",
    "GATE-3": fault(0.05) ? "fail" : "pass",
    "GATE-4": fault(0.05) ? "not_visited" : "pass",
  });
  return {
    stop: pick(next, stops),
    stations,
    gates,
    inputs,
    decisions_unmeasured: fault(0.2) ? ["d-1"] : [],
    gate4_warnings: fault(0.2) ? ["spend_unverifiable"] : [],
    injected_gates: fault(0.1) ? ["GATE-3"] : [],
    declared_level: "L2",
  };
}

describe("the classifier is total and can only lower a result (whole-table safety net)", () => {
  it("never yields a success, a merge recommendation or an input outcome that dispositionOf refuses", () => {
    const next = lcg(20261014);
    const seen = { success: 0, flawed: 0, blocked: 0, manual: 0, merge: 0 };
    for (let n = 0; n < 4000; n += 1) {
      const input = randomInput(next);
      const c = classifyOutcome(input);
      const disposition = dispositionOf(toOutcomeInput(c)); // an OutcomeError here fails the test
      seen[c.outcome] += 1;
      if (c.outcome !== "success") expect(c.reason_code).not.toBeNull();
      if (c.recommendation === "merge_recommended") {
        seen.merge += 1;
        expect(c.outcome).toBe("success");
        expect(c.unverified_areas).toEqual([]);
      }
      if (disposition.action === "submit" && disposition.recommendation === "merge_recommended")
        expect(c.unverified_areas).toEqual([]);
      if (c.outcome !== "success") continue;
      // An independent statement of what a success needs.
      const i = input.inputs;
      expect(input.stop.kind).toBe("none");
      expect(STATION_IDS.every((id) => input.stations[id] === "ok")).toBe(true);
      expect(input.gates.verdict).toBe("pass");
      expect([i.audit.canary_hits, i.audit.tests_edited, i.audit.prove_test, i.audit.judge_config_touched]).toEqual([
        0,
        false,
        "pass",
        false,
      ]);
      expect(
        i.sealed.train !== NOT_RUN &&
          i.sealed.train.total > 0 &&
          i.sealed.train.pass === i.sealed.train.total &&
          i.sealed.train.flaky === 0,
      ).toBe(true);
      expect(i.sealed.test !== NOT_RUN && i.sealed.test.total > 0 && i.sealed.test.pass === i.sealed.test.total).toBe(
        true,
      );
      expect(["L2", "L3"]).toContain(i.isolation_level);
      expect(i.gate_line).not.toBe(NOT_RUN);
      expect(i.noise_check).not.toBe("within_variance");
    }
    // The generator reaches every outcome, so the loop above is not vacuous.
    expect(seen.success).toBeGreaterThan(0);
    expect(seen.flawed).toBeGreaterThan(0);
    expect(seen.blocked).toBeGreaterThan(0);
    expect(seen.manual).toBeGreaterThan(0);
    expect(seen.merge).toBeGreaterThan(0);
  });
});
