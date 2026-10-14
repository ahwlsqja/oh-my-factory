import { describe, expect, it } from "vitest";
import {
  type Gate4Input,
  type Gate4Reason,
  type Gate4Severity,
  VISITS_PER_STATION_PER_ROUND,
  VisitCounter,
  evaluateGate4,
  gate4Result,
  roundSignature,
  totalVisitCap,
} from "../../src/work/gate4.js";
import type { WorkBudgetState } from "../../src/work/w-budget.js";

const SIG_A = "a".repeat(64);
const SIG_B = "b".repeat(64);
const LIMITS = { max_rounds: 3, max_model_micro_usd: 5_000_000 };

/** A healthy budget state: limits recorded, one round started, nothing spent, no anomaly. */
function budget(over: Partial<WorkBudgetState> = {}): WorkBudgetState {
  return {
    limits: LIMITS,
    raised: { rounds: 0, model_micro_usd: 0 },
    effective: LIMITS,
    rounds_started: 1,
    previous_signature: null,
    spend: { micro_usd: 0, unknown_count: 0 },
    anomalies: [],
    ...over,
  };
}

/** Input that passes: first visit of S4 in a round, no rework wanted, no re-entry facts. */
function input(over: Partial<Gate4Input> = {}): Gate4Input {
  return {
    budget: budget(),
    visits: { in_round: 1, total: 1, entering: "S4" },
    next_round_wanted: false,
    stall: { current: null, rework: false },
    reentry: { same_reason: 0, kills: 0 },
    ...over,
  };
}

const withLimits = (max_rounds: number, usd: number): Partial<WorkBudgetState> => ({
  limits: { max_rounds, max_model_micro_usd: usd },
  effective: { max_rounds, max_model_micro_usd: usd },
});

type Row = [label: string, input: Gate4Input, reasons: Gate4Reason[], severity: Gate4Severity];

const ROWS: Row[] = [
  ["a healthy state passes", input(), [], "none"],
  ["limits never recorded", input({ budget: budget({ limits: null, effective: null }) }), ["limits_missing"], "integrity"],
  ["one ledger anomaly", input({ budget: budget({ anomalies: [{ code: "round_gap", seq: 7 }] }) }), ["ledger_anomaly"], "integrity"],
  ["the third visit of a node in a round passes", input({ visits: { in_round: 3, total: 3, entering: "S4" } }), [], "none"],
  ["the fourth visit of a node in a round", input({ visits: { in_round: 4, total: 4, entering: "S4" } }), ["visit_cap"], "hard"],
  ["total 20 passes at 20 x 1 round", input({ budget: budget(withLimits(1, 5_000_000)), visits: { in_round: 1, total: 20, entering: "S5" } }), [], "none"],
  ["total 21 fails at 20 x 1 round", input({ budget: budget(withLimits(1, 5_000_000)), visits: { in_round: 1, total: 21, entering: "S5" } }), ["total_visit_cap"], "hard"],
  ["total 60 passes at 20 x 3 rounds", input({ visits: { in_round: 1, total: 60, entering: "S5" } }), [], "none"],
  ["total 61 fails at 20 x 3 rounds", input({ visits: { in_round: 1, total: 61, entering: "S5" } }), ["total_visit_cap"], "hard"],
  ["a rework request with an unchanged signature", input({ budget: budget({ previous_signature: SIG_A }), stall: { current: SIG_A, rework: true } }), ["stalled"], "hard"],
  ["an unchanged signature without a rework request", input({ budget: budget({ previous_signature: SIG_A }), stall: { current: SIG_A, rework: false } }), [], "none"],
  ["a rework request with a changed signature", input({ budget: budget({ previous_signature: SIG_A }), stall: { current: SIG_B, rework: true } }), [], "none"],
  ["a rework request in round 1 (no previous signature)", input({ stall: { current: SIG_A, rework: true } }), [], "none"],
  ["rounds used up and another round wanted", input({ budget: budget({ rounds_started: 3 }), next_round_wanted: true }), ["rounds_exhausted"], "soft"],
  ["rounds used up and no other round wanted", input({ budget: budget({ rounds_started: 3 }), next_round_wanted: false }), [], "none"],
  ["one round left and another wanted", input({ budget: budget({ rounds_started: 2 }), next_round_wanted: true }), [], "none"],
  ["spend over the limit", input({ budget: budget({ spend: { micro_usd: 5_000_001, unknown_count: 0 } }) }), ["spend_exhausted"], "soft"],
  ["spend equal to the limit, no next round", input({ budget: budget({ spend: { micro_usd: 5_000_000, unknown_count: 0 } }) }), [], "none"],
  ["spend equal to the limit, next round wanted", input({ budget: budget({ spend: { micro_usd: 5_000_000, unknown_count: 0 } }), next_round_wanted: true }), ["spend_exhausted"], "soft"],
  ["the same park reason three times since the last human act", input({ reentry: { same_reason: 3, kills: 0 } }), ["reentry_loop"], "hard"],
  ["three kills since the last human act", input({ reentry: { same_reason: 0, kills: 3 } }), ["reentry_loop"], "hard"],
  ["two of each is not a loop", input({ reentry: { same_reason: 2, kills: 2 } }), [], "none"],
  [
    "a visit cap and exhausted rounds together take the highest severity",
    input({ budget: budget({ rounds_started: 3 }), next_round_wanted: true, visits: { in_round: 4, total: 4, entering: "S4" } }),
    ["visit_cap", "rounds_exhausted"],
    "hard",
  ],
  [
    "an anomaly outranks a soft limit",
    input({ budget: budget({ rounds_started: 3, anomalies: [{ code: "limits_twice", seq: 3 }] }), next_round_wanted: true }),
    ["ledger_anomaly", "rounds_exhausted"],
    "integrity",
  ],
  ["a raised limit changes the verdict", input({ budget: budget({ rounds_started: 3, raised: { rounds: 1, model_micro_usd: 0 }, effective: { ...LIMITS, max_rounds: 4 } }), next_round_wanted: true }), [], "none"],
  ["line entry on a fresh item", input({ budget: budget({ rounds_started: 0 }), visits: { in_round: 0, total: 0, entering: null }, next_round_wanted: true }), [], "none"],
  ["line entry after the rounds are used up", input({ budget: budget({ rounds_started: 3 }), visits: { in_round: 0, total: 0, entering: null }, next_round_wanted: true }), ["rounds_exhausted"], "soft"],
];

describe("evaluateGate4", () => {
  for (const [label, row, reasons, severity] of ROWS) {
    it(label, () => {
      const result = evaluateGate4(row);
      expect(result.reasons).toEqual(reasons);
      expect(result.severity).toBe(severity);
      expect(result.verdict).toBe(reasons.length === 0 ? "pass" : "fail");
    });
  }

  it("lets unknown spend alone pass, with a warning (M3b2-D2)", () => {
    const result = evaluateGate4(input({ budget: budget({ spend: { micro_usd: 0, unknown_count: 2 } }) }));
    expect(result).toEqual({ verdict: "pass", severity: "none", reasons: [], warnings: ["spend_unverifiable"] });
  });

  it("keeps the warning when the check fails for another reason", () => {
    const result = evaluateGate4(input({ budget: budget({ rounds_started: 3, spend: { micro_usd: 0, unknown_count: 1 } }), next_round_wanted: true }));
    expect(result.reasons).toEqual(["rounds_exhausted"]);
    expect(result.warnings).toEqual(["spend_unverifiable"]);
  });

  it("states the caps as the spec does: 3 visits per node per round, max(10, 20 x rounds) in total", () => {
    expect(VISITS_PER_STATION_PER_ROUND).toBe(3);
    expect([1, 2, 3, 10].map((rounds) => totalVisitCap(rounds))).toEqual([20, 40, 60, 200]);
    // The floor of 10 only bites below one round; config refuses max_rounds < 1, so it is a guard, not a normal case.
    expect(totalVisitCap(0)).toBe(10);
  });
});

describe("gate4Result", () => {
  it("maps a result onto the board with closed reason codes only", () => {
    const failed = evaluateGate4(input({ budget: budget({ rounds_started: 3 }), next_round_wanted: true, visits: { in_round: 4, total: 4, entering: "S4" } }));
    expect(gate4Result(failed)).toEqual({ gate: "GATE-4", verdict: "fail", reasons: ["visit_cap", "rounds_exhausted"] });
    expect(gate4Result(evaluateGate4(input()))).toEqual({ gate: "GATE-4", verdict: "pass", reasons: [] });
    for (const row of ROWS) {
      for (const reason of gate4Result(evaluateGate4(row[1])).reasons) expect(reason).toMatch(/^[a-z0-9_]+$/);
    }
  });
});

describe("VisitCounter", () => {
  it("counts per node and in total, starts in round 0, and a new round resets the node counts but not the total", () => {
    const visits = new VisitCounter();
    expect(visits.round).toBe(0);
    expect(visits.enter("S1")).toEqual({ in_round: 1, total: 1 });
    expect(visits.enter("S1")).toEqual({ in_round: 2, total: 2 });
    expect(visits.enter("GATE-2")).toEqual({ in_round: 1, total: 3 });

    visits.startRound();
    expect(visits.round).toBe(1);
    expect(visits.enter("S1")).toEqual({ in_round: 1, total: 4 });
    visits.startRound();
    expect(visits.round).toBe(2);
  });
});

describe("roundSignature", () => {
  const base = [
    { node: "S3" as const, status: "ok" as const, digest: SIG_A },
    { node: "S4" as const, status: "ok" as const, digest: null },
  ];

  it("is 64 hex, stable, and sensitive to order, status and digest", () => {
    const sig = roundSignature(base);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(roundSignature(base)).toBe(sig);
    expect(roundSignature([...base].reverse())).not.toBe(sig);
    expect(roundSignature([{ ...base[0]!, status: "rework" }, base[1]!])).not.toBe(sig);
    expect(roundSignature([{ ...base[0]!, digest: SIG_B }, base[1]!])).not.toBe(sig);
    expect(roundSignature([{ ...base[0]!, digest: null }, base[1]!])).not.toBe(sig);
  });

  it("does not depend on the key order of an entry, and accepts a gate verdict as a status", () => {
    const reordered = [{ digest: SIG_A, status: "ok" as const, node: "S3" as const }, base[1]!];
    expect(roundSignature(reordered)).toBe(roundSignature(base));
    const withGate = roundSignature([...base, { node: "GATE-3" as const, status: "pass" as const, digest: null }]);
    expect(withGate).not.toBe(roundSignature(base));
    expect(withGate).toMatch(/^[0-9a-f]{64}$/);
  });
});
