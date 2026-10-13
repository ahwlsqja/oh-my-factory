import { describe, expect, it } from "vitest";
import { evaluateTarget } from "../../src/goal/evaluate.js";
import type { BandAction, BandResult } from "../../src/goal/bands.js";
import type { Operator } from "../../src/goal/goal-file.js";
import type { GapReport, MetricMeasurement } from "../../src/goal/measure.js";
import { summarizeGap } from "../../src/goal/gap-summary.js";

function reportOf(
  options: { operator?: Operator; target?: number; measured?: number | null; metrics?: MetricMeasurement[]; pending?: boolean } = {},
): GapReport {
  const operator = options.operator ?? "<=";
  const value = options.target ?? 100;
  const measured = options.measured === undefined ? 130 : options.measured;
  return {
    schema_version: 1,
    goal_id: "g-fast",
    regime: 1,
    measured_at: "2026-10-12T09:00:00.000Z",
    runner: "host",
    isolation: "none",
    target: {
      metric_id: "m-p95",
      operator,
      value,
      unit: "ms",
      measured,
      result: measured === null ? null : evaluateTarget({ operator, value }, measured),
    },
    metrics: options.metrics ?? [],
    guardrails: [],
    regime_changes: [],
    needs_reapproval: options.pending ?? false,
    budget: null,
    wall_time_exceeded: false,
  };
}

function breaching(tier: "1sigma" | "2sigma" | "3sigma", action: BandAction | null): MetricMeasurement {
  const band: BandResult = { status: "breach", tier, rule: "beyond_sigma", mean: 10, sigma: 1 };
  return { metric_id: "m-errors", roles: ["guardrail"], unit: "%", value: 40, failure: null, band, band_action: action };
}

describe("summarizeGap", () => {
  it("reports the direction of an unmet build target", () => {
    expect(summarizeGap(reportOf({ operator: "<=", measured: 130 }), "build").summary).toEqual({
      trigger: "gap",
      gap: { direction: "decrease", size: "medium" },
      breach: null,
    });
    expect(summarizeGap(reportOf({ operator: ">=", measured: 95 }), "build").summary).toMatchObject({
      gap: { direction: "increase", size: "small" },
    });
  });

  it("buckets the size at the 0.1 and 0.5 edges of the relative gap", () => {
    const size = (measured: number): string | undefined =>
      summarizeGap(reportOf({ target: 100, measured }), "build").summary?.gap?.size;
    expect(size(109)).toBe("small");
    expect(size(110)).toBe("medium");
    expect(size(149)).toBe("medium");
    expect(size(150)).toBe("large");
  });

  it("has no trigger once the target is met", () => {
    expect(summarizeGap(reportOf({ measured: 90 }), "build")).toEqual({ summary: null, none: { reason: "target_met" } });
  });

  it("never raises a gap trigger in watch mode", () => {
    expect(summarizeGap(reportOf({ measured: 500 }), "watch")).toEqual({ summary: null, none: { reason: "idle" } });
  });

  it("is idle when the target could not be measured and nothing breached", () => {
    expect(summarizeGap(reportOf({ measured: null }), "build")).toEqual({ summary: null, none: { reason: "idle" } });
  });

  it("raises a breach trigger for a propose action in either mode, severe beyond 3 sigma", () => {
    const severe = reportOf({ measured: 90, metrics: [breaching("3sigma", "propose")] });
    expect(summarizeGap(severe, "watch").summary).toEqual({ trigger: "breach", gap: null, breach: { severity: "severe" } });
    // Being at target does not excuse a breach (D17).
    expect(summarizeGap(severe, "build").summary).toEqual({ trigger: "breach", gap: null, breach: { severity: "severe" } });
    const elevated = reportOf({ metrics: [breaching("2sigma", "propose")] });
    expect(summarizeGap(elevated, "watch").summary?.breach).toEqual({ severity: "elevated" });
  });

  it("lets the worst tier win when several metrics breach", () => {
    const report = reportOf({ metrics: [breaching("2sigma", "propose"), breaching("3sigma", "propose")] });
    expect(summarizeGap(report, "watch").summary?.breach).toEqual({ severity: "severe" });
  });

  it("ignores breaches whose action is diagnose, log, or absent", () => {
    for (const action of ["diagnose", "log", null] as const) {
      const report = reportOf({ metrics: [breaching("3sigma", action)] });
      expect(summarizeGap(report, "watch")).toEqual({ summary: null, none: { reason: "idle" } });
    }
  });

  it("combines a gap and a breach into one both trigger", () => {
    const report = reportOf({ measured: 130, metrics: [breaching("2sigma", "propose")] });
    expect(summarizeGap(report, "build").summary).toEqual({
      trigger: "both",
      gap: { direction: "decrease", size: "medium" },
      breach: { severity: "elevated" },
    });
  });

  it("is never a trigger while a regime change is pending", () => {
    const report = reportOf({ measured: 500, pending: true, metrics: [breaching("3sigma", "propose")] });
    expect(summarizeGap(report, "build")).toEqual({ summary: null, none: { reason: "idle" } });
  });

  it("throws on an unmet result that has no direction", () => {
    const report = reportOf();
    report.target.result = { met: false, gap: 1, direction: "none", relative: 0.1, size: "small" };
    expect(() => summarizeGap(report, "build")).toThrow("no direction or size");
  });

  it("carries no number, metric id or unit", () => {
    const report = reportOf({ measured: 130, metrics: [breaching("3sigma", "propose")] });
    const text = JSON.stringify(summarizeGap(report, "build").summary);
    expect(text).not.toMatch(/\d/);
    expect(text).not.toContain("m-");
    expect(text).not.toContain("ms");
  });
});
