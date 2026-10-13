import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { LedgerEvent } from "../../src/core/ledger.js";
import { MIN_CONSECUTIVE_MET, evaluateSuccess } from "../../src/goal/success.js";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-12T00:00:00.000Z");
const ZERO = "0".repeat(64);
let seq = 0;

function iso(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

/** A goal.measured event as `measureGoal` writes it: met, no guardrails, no pending regime change. */
function measured(offsetMs: number, payload: Record<string, unknown> = {}, goalId = "g-fast"): LedgerEvent {
  seq += 1;
  return {
    schema_version: 1,
    seq,
    prev_hash: ZERO,
    ts: iso(offsetMs),
    actor: "omf",
    type: "goal.measured",
    payload: {
      goal_id: goalId,
      regime: 1,
      report: "goals/g-fast/reports/x-gap.json",
      target_met: true,
      needs_reapproval: false,
      guardrails: "none",
      ...payload,
    },
    hash: ZERO,
  };
}

function evaluate(
  events: readonly LedgerEvent[],
  options: { regime?: number; now?: number; minObservationMs?: number } = {},
): ReturnType<typeof evaluateSuccess> {
  return evaluateSuccess({
    events,
    goalId: "g-fast",
    regime: options.regime ?? 1,
    minObservationMs: options.minObservationMs ?? HOUR,
    now: new Date(T0 + (options.now ?? 0)),
  });
}

describe("evaluateSuccess: the candidate", () => {
  it("needs a streak of at least two", () => {
    expect(MIN_CONSECUTIVE_MET).toBe(2);
  });

  it("is a candidate after two met measurements spanning min_observation", () => {
    const verdict = evaluate([measured(0), measured(HOUR)], { now: HOUR });
    expect(verdict).toEqual({ kind: "candidate", first_met_at: iso(0), consecutive: 2, attribution: "before_after" });
  });

  it("counts a longer streak and reports its first timestamp", () => {
    const verdict = evaluate([measured(0), measured(HOUR), measured(2 * HOUR)], { now: 2 * HOUR });
    expect(verdict).toEqual({ kind: "candidate", first_met_at: iso(0), consecutive: 3, attribution: "before_after" });
  });

  it("accepts guardrails pass as well as none", () => {
    const verdict = evaluate([measured(0, { guardrails: "pass" }), measured(HOUR, { guardrails: "pass" })], { now: HOUR });
    expect(verdict.kind).toBe("candidate");
  });

  it("is undetermined with consecutive when only one measurement exists", () => {
    expect(evaluate([measured(0)], { now: 2 * HOUR })).toEqual({ kind: "undetermined", missing: ["consecutive"] });
  });

  it("is undetermined with min_observation when the streak spans too little time", () => {
    expect(evaluate([measured(0), measured(10 * MINUTE)], { now: 10 * MINUTE })).toEqual({
      kind: "undetermined",
      missing: ["min_observation"],
    });
  });

  it("measures the span from the first met point up to now, not up to the last measurement", () => {
    const events = [measured(0), measured(10 * MINUTE)];
    expect(evaluate(events, { now: HOUR }).kind).toBe("candidate");
    expect(evaluate(events, { now: HOUR - 1 }).kind).toBe("undetermined");
  });

  it("reports both gaps when nothing has been measured yet", () => {
    expect(evaluate([])).toEqual({ kind: "undetermined", missing: ["consecutive", "min_observation"] });
  });
});

describe("evaluateSuccess: the streak", () => {
  it("is reset by a miss in between", () => {
    const events = [measured(0), measured(HOUR, { target_met: false }), measured(2 * HOUR)];
    expect(evaluate(events, { now: 4 * HOUR })).toEqual({ kind: "undetermined", missing: ["consecutive"] });
    const later = evaluate([...events, measured(3 * HOUR)], { now: 3 * HOUR });
    expect(later).toEqual({ kind: "candidate", first_met_at: iso(2 * HOUR), consecutive: 2, attribution: "before_after" });
  });

  it("is broken by a measurement taken while a regime change was pending", () => {
    const pending = { target_met: null, needs_reapproval: true };
    const events = [measured(0), measured(HOUR, pending), measured(2 * HOUR)];
    expect(evaluate(events, { now: 4 * HOUR })).toEqual({ kind: "undetermined", missing: ["consecutive"] });
  });

  it("is regime_pending while the newest measurement carries the mark", () => {
    const events = [measured(0), measured(HOUR, { target_met: null, needs_reapproval: true })];
    expect(evaluate(events, { now: 4 * HOUR })).toEqual({ kind: "undetermined", missing: ["regime_pending"] });
  });

  it("recovers once enough clean measurements follow a pending one", () => {
    const events = [
      measured(0),
      measured(HOUR, { target_met: null, needs_reapproval: true }),
      measured(2 * HOUR),
      measured(3 * HOUR),
    ];
    expect(evaluate(events, { now: 3 * HOUR })).toEqual({
      kind: "candidate",
      first_met_at: iso(2 * HOUR),
      consecutive: 2,
      attribution: "before_after",
    });
  });

  it("is target_not_met when the newest measurement misses", () => {
    expect(evaluate([measured(0), measured(HOUR, { target_met: false })], { now: HOUR })).toEqual({
      kind: "undetermined",
      missing: ["target_not_met"],
    });
  });

  it("does not count a previous regime's streak", () => {
    const old = [measured(0, { regime: 1 }), measured(HOUR, { regime: 1 })];
    expect(evaluate(old, { regime: 2, now: 4 * HOUR })).toEqual({ kind: "undetermined", missing: ["consecutive", "min_observation"] });
    const mixed = [...old, measured(2 * HOUR, { regime: 2 })];
    expect(evaluate(mixed, { regime: 2, now: 4 * HOUR })).toEqual({ kind: "undetermined", missing: ["consecutive"] });
  });

  it("ignores measurements of other goals and events of other types", () => {
    const other = measured(0, {}, "g-other");
    const unrelated: LedgerEvent = { ...measured(0), type: "metric.measured" };
    expect(evaluate([other, unrelated, measured(HOUR)], { now: 2 * HOUR })).toEqual({
      kind: "undetermined",
      missing: ["consecutive"],
    });
  });
});

describe("evaluateSuccess: guardrails (spec F7, E4)", () => {
  it("never succeeds while a guardrail is unevaluated", () => {
    const events = [measured(0, { guardrails: "unevaluated" }), measured(HOUR, { guardrails: "unevaluated" })];
    expect(evaluate(events, { now: 9 * HOUR })).toEqual({ kind: "undetermined", missing: ["guardrail_unevaluated"] });
  });

  it("reads a legacy event with no guardrails field as unevaluated", () => {
    const events = [measured(0, { guardrails: undefined }), measured(HOUR, { guardrails: undefined })];
    expect(evaluate(events, { now: 9 * HOUR })).toEqual({ kind: "undetermined", missing: ["guardrail_unevaluated"] });
  });

  it("is guardrail_breach when the newest measurement breaches", () => {
    const events = [measured(0), measured(HOUR, { guardrails: "breach" })];
    expect(evaluate(events, { now: 9 * HOUR })).toEqual({ kind: "undetermined", missing: ["guardrail_breach"] });
  });

  it("lists the target and the guardrail when both fail", () => {
    const events = [measured(0), measured(HOUR, { target_met: false, guardrails: "breach" })];
    expect(evaluate(events, { now: 9 * HOUR })).toEqual({
      kind: "undetermined",
      missing: ["target_not_met", "guardrail_breach"],
    });
  });

  it("ends the streak at an earlier unevaluated measurement", () => {
    const events = [measured(0, { guardrails: "pass" }), measured(HOUR, { guardrails: "unevaluated" }), measured(2 * HOUR, { guardrails: "pass" })];
    expect(evaluate(events, { now: 9 * HOUR })).toEqual({ kind: "undetermined", missing: ["consecutive"] });
  });

  it("treats an unknown aggregate as unevaluated", () => {
    const events = [measured(0, { guardrails: "ok" }), measured(HOUR, { guardrails: "ok" })];
    expect(evaluate(events, { now: 9 * HOUR })).toEqual({ kind: "undetermined", missing: ["guardrail_unevaluated"] });
  });
});

describe("success.ts", () => {
  it("never reads the clock", () => {
    const source = readFileSync(new URL("../../src/goal/success.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/Date\.now\(|new Date\(\s*\)/);
  });
});
