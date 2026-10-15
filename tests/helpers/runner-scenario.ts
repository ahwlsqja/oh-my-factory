import type { Expect, ScenarioStep, StoredScenario } from "../../src/scenario/types.js";

/** Built at run time: a full canary literal in a source file would trip the poka-yoke scan of this repository (M3c-D13). */
export const TEST_CANARY = `omf-canary-${"c".repeat(32)}`;

/** One step with every expectation field null unless `expect` sets it; the note carries the canary like a stamped scenario. */
export function stepOf(argv: string[], expect: Partial<Expect> = {}, stdin = ""): ScenarioStep {
  return {
    invoke: { argv, stdin },
    expect: { exit_code: null, stdout_matches: null, json_path: null, note: `${TEST_CANARY} test`, ...expect },
  };
}

/** A stored behavior scenario with fixed identity; override any field. */
export function runnerScenario(overrides: Partial<StoredScenario> = {}): StoredScenario {
  return {
    schema_version: 1,
    scenario_id: `s-${"1".repeat(32)}`,
    work_id: "w-test",
    author: { vendor: "command", model: "stub", at: "2026-10-14T00:00:00.000Z", isolation: "host_command" },
    decision_refs: ["d-interface"],
    kind: "behavior",
    split: "train",
    interface: "cli",
    steps: [stepOf(["list"], { exit_code: 0 })],
    canary: TEST_CANARY,
    ...overrides,
  };
}
