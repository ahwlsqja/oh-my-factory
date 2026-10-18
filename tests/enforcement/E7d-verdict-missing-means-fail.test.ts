// covers: S5.0.empty-means-fail
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JudgeRoundError } from "../../src/judge/round.js";
import { runRound, scenarioOf, stepOf } from "../helpers/judge-fixture.js";
import { resetMeasureHook } from "../helpers/measure-mock.js";
import { exited, RuntimeDouble, type Tamper } from "../helpers/sut-double.js";

vi.mock("../../src/container/measure.js", async () => (await import("../helpers/measure-mock.js")).measureMockModule());
beforeEach(resetMeasureHook);

// The verdict half of E7: no verdict, a malformed or foreign one, and one that disagrees with what the host relayed itself
// all end the round in an error and never yield counts. Scenario 1 passes and scenario 2 fails, so a flipped outcome is visible.
const scenarios = () => [scenarioOf(1, [stepOf(["a"], 0)]), scenarioOf(2, [stepOf(["b"], 1)])];

const CASES: [string, Tamper, string | null][] = [
  ["an empty verdict reply", (request, reply) => (request.op === "verdict" ? null : reply), null],
  ["a malformed verdict reply", (request, reply) => (request.op === "verdict" ? "{not json" : reply), null],
  [
    "a verdict with a foreign nonce",
    (_request, reply) =>
      reply.op === "verdict"
        ? { ...reply, nonce: "f".repeat(16), verdict: { ...reply.verdict, nonce: "f".repeat(16) } }
        : reply,
    null,
  ],
  [
    "a verdict that drops a run",
    (_request, reply) =>
      reply.op === "verdict" ? { ...reply, verdict: { ...reply.verdict, runs: reply.verdict.runs.slice(1) } } : reply,
    "verdict_mismatch",
  ],
  [
    "a verdict that turns a fail into a pass",
    (_request, reply) =>
      reply.op === "verdict"
        ? {
            ...reply,
            verdict: {
              ...reply.verdict,
              runs: reply.verdict.runs.map((run) => ({
                ...run,
                outcome: "pass" as const,
                steps_passed: run.steps_total,
              })),
            },
          }
        : reply,
    "verdict_mismatch",
  ],
  [
    "an observe reply that passes a step the host saw fail",
    (_request, reply) => (reply.op === "observe" ? { ...reply, step_pass: true } : reply),
    "verdict_mismatch",
  ],
];

describe("E7d-verdict-missing-means-fail", () => {
  it("runs clean with an honest harness (control)", async () => {
    const verdict = await runRound(new RuntimeDouble(() => exited("")), scenarios(), { k: 2 });
    expect(verdict.counts).toEqual({ total: 2, pass: 1, fail: 1, flaky: 0, error: 0 });
  });

  it.each(CASES)("ends the round when it gets %s", async (_name, tamper, code) => {
    const double = new RuntimeDouble(() => exited(""));
    double.tamper = tamper;
    const rejected = runRound(double, scenarios(), { k: 2 });
    await expect(rejected).rejects.toBeInstanceOf(JudgeRoundError);
    if (code !== null) await expect(rejected).rejects.toMatchObject({ code });
    // The harness and every SUT container are gone whichever way the round ended: removed one by one, or by the final sweep.
    const removed = new Set(double.calls.filter((call) => call.startsWith("remove:")).map((call) => call.slice(7)));
    const swept = double.calls
      .filter((call) => call.startsWith("removeAllSync:"))
      .flatMap((call) => call.slice(14).split(","));
    for (const spec of double.specs) expect(removed.has(spec.name) || swept.includes(spec.name)).toBe(true);
  });
});
