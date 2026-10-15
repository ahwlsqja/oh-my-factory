import { describe, expect, it } from "vitest";
import { DEFAULT_STEP_LIMITS, runScenario } from "../../src/scenario/runner.js";
import type { RunTarget, ScenarioRunner, StepInput, StepLimits, StepObservation } from "../../src/scenario/runner.js";
import { scenarioRef } from "../../src/scenario/types.js";
import { stepOf, runnerScenario } from "../helpers/runner-scenario.js";

const TARGET: RunTarget = { kind: "fixture", id: "null-empty" };

/** A runner that answers from a script and records what the port was asked; an Error entry is thrown by that step. */
function scripted(observations: readonly (StepObservation | Error)[]) {
  const log = { opened: 0, closed: 0, steps: [] as StepInput[], limits: [] as StepLimits[] };
  const runner: ScenarioRunner = {
    id: "scripted",
    executes: "omf_fixture",
    async openScenario() {
      log.opened += 1;
      let next = 0;
      return {
        async runStep(step, limits) {
          log.steps.push(step);
          log.limits.push(limits);
          const observation = observations[next];
          next += 1;
          if (observation === undefined) throw new Error("scripted runner ran out of observations");
          if (observation instanceof Error) throw observation;
          return observation;
        },
        async close() {
          log.closed += 1;
        },
      };
    },
  };
  return { runner, log };
}

const exited = (exit_code: number, stdout = ""): StepObservation => ({ outcome: "exited", exit_code, stdout });

describe("runScenario", () => {
  it("runs the steps in order in one session and passes when every step matches", async () => {
    const scenario = runnerScenario({
      steps: [
        stepOf(["add", "x"], { exit_code: 0 }),
        stepOf(["list"], { exit_code: 0, stdout_matches: { kind: "exact", text: "x\n" } }),
      ],
    });
    const { runner, log } = scripted([exited(0), exited(0, "x\n")]);
    const limits = { timeoutMs: 1000, maxOutputBytes: 2048 };
    const run = await runScenario(runner, TARGET, scenario, limits);
    expect(run).toEqual({
      scenario_ref: scenarioRef(scenario.scenario_id),
      outcome: "pass",
      steps_passed: 2,
      steps_total: 2,
    });
    expect(log.opened).toBe(1);
    expect(log.closed).toBe(1);
    expect(log.steps).toEqual([
      { argv: ["add", "x"], stdin: "" },
      { argv: ["list"], stdin: "" },
    ]);
    expect(log.limits).toEqual([limits, limits]);
  });

  it("stops at the first failing step and does not run the rest", async () => {
    const scenario = runnerScenario({
      steps: [stepOf(["a"], { exit_code: 0 }), stepOf(["b"], { exit_code: 0 }), stepOf(["c"], { exit_code: 0 })],
    });
    const { runner, log } = scripted([exited(0), exited(1)]);
    const run = await runScenario(runner, TARGET, scenario);
    expect(run).toMatchObject({ outcome: "fail", steps_passed: 1, steps_total: 3 });
    expect(log.steps).toHaveLength(2);
    expect(log.closed).toBe(1);
  });

  it.each<StepObservation>([
    { outcome: "timeout" },
    { outcome: "output_limit" },
    { outcome: "error" },
    { outcome: "refused", code: "unknown_fixture" },
  ])("is an error and never a pass for %j", async (observation) => {
    const scenario = runnerScenario({ steps: [stepOf(["list"], { exit_code: 0 })] });
    const { runner, log } = scripted([observation]);
    const run = await runScenario(runner, TARGET, scenario);
    expect(run).toMatchObject({ outcome: "error", steps_passed: 0, steps_total: 1 });
    expect(log.closed).toBe(1);
  });

  it("fails, rather than errors, when the child was ended by a signal", async () => {
    const scenario = runnerScenario({ steps: [stepOf(["list"], { exit_code: 0 })] });
    const { runner } = scripted([{ outcome: "signaled", signal: "SIGKILL" }]);
    expect(await runScenario(runner, TARGET, scenario)).toMatchObject({ outcome: "fail", steps_passed: 0 });
  });

  it("closes the session when a step throws", async () => {
    const scenario = runnerScenario();
    const { runner, log } = scripted([new Error("boom")]);
    await expect(runScenario(runner, TARGET, scenario)).rejects.toThrow("boom");
    expect(log.closed).toBe(1);
  });

  it("reports the scenario_ref and counts, never the id or any text", async () => {
    const scenario = runnerScenario();
    const { runner } = scripted([exited(0)]);
    const run = await runScenario(runner, TARGET, scenario);
    expect(Object.keys(run).sort()).toEqual(["outcome", "scenario_ref", "steps_passed", "steps_total"]);
    expect(JSON.stringify(run)).not.toContain(scenario.scenario_id);
  });

  it("defaults to 5 seconds and 1 MiB per step", () => {
    expect(DEFAULT_STEP_LIMITS).toEqual({ timeoutMs: 5000, maxOutputBytes: 1024 * 1024 });
  });
});
