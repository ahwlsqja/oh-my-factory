// covers: F7.unevaluated-undetermined
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readConfig } from "../../src/core/config.js";
import { MIN_BASELINE_POINTS, bandsFile } from "../../src/goal/bands.js";
import { type TickResult, tickGoal } from "../../src/goal/tick.js";
import {
  type EnforcementFixture,
  type EnforcementOptions,
  GOAL_ID,
  GUARDRAIL_METRIC,
  ledgerEvents,
  setupEnforcementGoal,
  unusedModel,
} from "../helpers/enforcement-goal.js";

// Spec §4.5 and F7: a guardrail that was not evaluated is not a passing guardrail. A goal whose guardrail
// has no bands file, or whose baseline is still too short, can never become a success candidate, however
// long it is observed. Ticks run in the library with a fake clock so days pass in milliseconds; the target
// is met on every tick (80 <= 100), so the guardrail is the only thing in the way.

const HOUR = 3_600_000;

/** Fixture options shared by all three cases: target met from the start, a guardrail, a short minimum observation. */
const MET: EnforcementOptions = { reading: 80, target: 100, wallTime: "30d", minObservation: "1h" };

/** Ticks until `ticks` have run or the goal stops continuing, advancing the clock by `stepMs` after each. */
async function observe(
  fx: EnforcementFixture,
  ticks: number,
  stepMs: number,
): Promise<{ results: TickResult[]; modelCalls: () => number }> {
  const config = readConfig(fx.location.dir);
  const model = unusedModel();
  const results: TickResult[] = [];
  let at = Date.now();
  for (let i = 0; i < ticks; i++) {
    const result = await tickGoal(fx.location, GOAL_ID, {
      runner: "host",
      reconciler: model.reconciler,
      config,
      now: () => new Date(at),
    });
    results.push(result);
    if (result.status !== "continue") break;
    at += stepMs;
  }
  return { results, modelCalls: model.calls };
}

const guardrailsOf = (fx: EnforcementFixture): unknown[] =>
  ledgerEvents(fx, "goal.measured").map((e) => e.payload.guardrails);

describe("E4 unevaluated-is-undetermined", () => {
  it("never succeeds while the bands file exists but the baseline window holds too few points", async () => {
    // Ticks 25 hours apart with a one-day baseline: every measurement sees an empty window, however many there are.
    const fx = setupEnforcementGoal({ ...MET, guardrail: "bands", baseline: "rolling_1d" });
    expect(existsSync(bandsFile(fx.location.dir, GOAL_ID, GUARDRAIL_METRIC))).toBe(true);

    const { results, modelCalls } = await observe(fx, MIN_BASELINE_POINTS + 3, 25 * HOUR);

    expect(results).toHaveLength(MIN_BASELINE_POINTS + 3);
    for (const result of results) {
      expect(result.status).toBe("continue");
      expect(result.outcome).toBe("observing");
      expect(result.reason_code).toBe("guardrail_unevaluated");
    }
    expect(ledgerEvents(fx, "goal.success_candidate")).toHaveLength(0);
    expect(ledgerEvents(fx, "goal.measured").every((e) => e.payload.target_met === true)).toBe(true);
    expect(guardrailsOf(fx).every((g) => g === "unevaluated")).toBe(true);
    expect(modelCalls()).toBe(0);
    expect(ledgerEvents(fx, "budget.consumed")).toHaveLength(0);
  });

  it("never succeeds while the guardrail has no bands file at all", async () => {
    const fx = setupEnforcementGoal({ ...MET, guardrail: "no-bands" });
    expect(existsSync(bandsFile(fx.location.dir, GOAL_ID, GUARDRAIL_METRIC))).toBe(false);

    const { results, modelCalls } = await observe(fx, MIN_BASELINE_POINTS + 3, 2 * HOUR);

    expect(results).toHaveLength(MIN_BASELINE_POINTS + 3);
    for (const result of results) {
      expect(result.outcome).toBe("observing");
      expect(result.reason_code).toBe("guardrail_unevaluated");
    }
    expect(ledgerEvents(fx, "goal.success_candidate")).toHaveLength(0);
    expect(ledgerEvents(fx, "goal.measured").every((e) => e.payload.target_met === true)).toBe(true);
    expect(guardrailsOf(fx).every((g) => g === "unevaluated")).toBe(true);
    expect(modelCalls()).toBe(0);
  });

  it("succeeds once the guardrail has an in-regime baseline and evaluates pass", async () => {
    const fx = setupEnforcementGoal({ ...MET, guardrail: "bands", baseline: "rolling_30d" });

    const { results, modelCalls } = await observe(fx, MIN_BASELINE_POINTS + 4, 2 * HOUR);

    // The first MIN_BASELINE_POINTS measurements have no baseline; the next one is the first evaluated pass
    // (a streak of one); the one after that makes the streak of two that spans the minimum observation.
    const at = results.findIndex((r) => r.outcome === "success_candidate");
    expect(at).toBe(MIN_BASELINE_POINTS + 1);
    expect(results[at]?.status).toBe("finish");
    expect(results).toHaveLength(MIN_BASELINE_POINTS + 2);
    expect(results.slice(0, MIN_BASELINE_POINTS).map((r) => r.reason_code)).toEqual(
      Array.from({ length: MIN_BASELINE_POINTS }, () => "guardrail_unevaluated"),
    );
    expect(results[MIN_BASELINE_POINTS]?.reason_code).toBe("consecutive");
    expect(guardrailsOf(fx)).toEqual([
      ...Array.from({ length: MIN_BASELINE_POINTS }, () => "unevaluated"),
      "pass",
      "pass",
    ]);
    const candidate = ledgerEvents(fx, "goal.success_candidate");
    expect(candidate).toHaveLength(1);
    expect(candidate[0]?.payload).toMatchObject({ attribution: "before_after", correlational: true });
    expect(modelCalls()).toBe(0);
  });
});
