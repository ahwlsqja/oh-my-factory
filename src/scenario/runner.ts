import { evaluateExpect } from "./matcher.js";
import { scenarioRef } from "./types.js";
import type { StepObservation, StoredScenario } from "./types.js";

export type { RefusalCode, StepObservation } from "./types.js";

/** The OMF-shipped fixtures a host adapter may execute (see `fixtures.ts`). */
export type FixtureId = "null-error" | "null-empty" | "echo-everything";
/** `handle` is opaque; the container adapter resolves it. The host adapter never does. */
export type RunTarget = { kind: "fixture"; id: FixtureId } | { kind: "candidate"; handle: string };

/** Data for the target, never a program: no element of a scenario is ever executed as a command. */
export interface StepInput {
  argv: readonly string[];
  stdin: string;
}

export interface StepLimits {
  timeoutMs: number;
  maxOutputBytes: number;
}
export const DEFAULT_STEP_LIMITS: StepLimits = { timeoutMs: 5000, maxOutputBytes: 1024 * 1024 };

/**
 * Port between the judge and whatever runs the thing under test. It returns an observation for one
 * step and never sees an expectation, so the host fixture adapter, the container judge and a laptop run
 * are all judged by the same `evaluateExpect`.
 *
 * Step-state model, identical for every adapter: the steps of ONE scenario share one scratch
 * directory (cwd, HOME, TMPDIR and any file a step writes); every scenario starts in a fresh, empty one.
 */
export interface ScenarioRunner {
  readonly id: string;
  /** What this adapter may execute. The host adapter says "omf_fixture" and refuses everything else. */
  readonly executes: "omf_fixture" | "candidate";
  /** One session per scenario: the adapter creates the scenario's scratch state here and tears it down in close(). */
  openScenario(target: RunTarget): Promise<ScenarioSession>;
}

export interface ScenarioSession {
  runStep(step: StepInput, limits: StepLimits): Promise<StepObservation>;
  /** Always called by `runScenario`, in finally. */
  close(): Promise<void>;
}

/** `scenario_ref` is the only scenario handle that may reach the ledger. */
export type ScenarioRun = {
  scenario_ref: string;
  outcome: "pass" | "fail" | "error";
  steps_passed: number;
  steps_total: number;
};

/**
 * Runs one scenario in one session and stops at the first failing step. "error" means a step was refused,
 * timed out, hit the output limit or errored: that is a fault of the environment, never a pass and never
 * evidence about the implementation. A child ended by a signal is a plain "fail" (`evaluateExpect` fails it
 * with `not_exited`). The session is closed in finally, also when a step throws.
 */
export async function runScenario(
  runner: ScenarioRunner,
  target: RunTarget,
  scenario: StoredScenario,
  limits: StepLimits = DEFAULT_STEP_LIMITS,
): Promise<ScenarioRun> {
  const session = await runner.openScenario(target);
  let passed = 0;
  let outcome: ScenarioRun["outcome"] = "pass";
  try {
    for (const step of scenario.steps) {
      const observation = await session.runStep({ argv: step.invoke.argv, stdin: step.invoke.stdin }, limits);
      if (
        observation.outcome === "timeout" ||
        observation.outcome === "output_limit" ||
        observation.outcome === "error" ||
        observation.outcome === "refused"
      ) {
        outcome = "error";
        break;
      }
      if (!evaluateExpect(step.expect, observation).pass) {
        outcome = "fail";
        break;
      }
      passed += 1;
    }
  } finally {
    await session.close();
  }
  return {
    scenario_ref: scenarioRef(scenario.scenario_id),
    outcome,
    steps_passed: passed,
    steps_total: scenario.steps.length,
  };
}
