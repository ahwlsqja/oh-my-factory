import { stringify } from "yaml";
import type { Ids, IntakeContext } from "../../src/scenario/intake.js";
import type { AuthorStamp, StoredScenario } from "../../src/scenario/types.js";

export const WORK_ID = "w-0123456789ab";
/** A valid stamp. `host_command` is what the stub author reports (M3c-D11). */
export const AUTHOR: AuthorStamp = {
  vendor: "command",
  model: "stub",
  at: "2026-10-12T00:00:00.000Z",
  isolation: "host_command",
};
/** Built at run time: no full canary literal may appear in a source file (M3c-D13). */
export const CANARY_A = `omf-canary-${"a".repeat(32)}`;

/** A valid stored scenario unless `over` says otherwise. */
export function storedScenario(over: Partial<StoredScenario> = {}): StoredScenario {
  return {
    schema_version: 1,
    scenario_id: `s-${"1".repeat(32)}`,
    work_id: WORK_ID,
    author: { ...AUTHOR },
    decision_refs: ["d-add"],
    kind: "behavior",
    split: "train",
    interface: "cli",
    steps: [
      {
        invoke: { argv: ["add", "milk"], stdin: "" },
        expect: {
          exit_code: 0,
          stdout_matches: { kind: "exact", text: "added milk\n" },
          json_path: null,
          note: `${CANARY_A} adding prints the item`,
        },
      },
    ],
    canary: CANARY_A,
    ...over,
  };
}

/** What an author writes: no identity, no canary, no status. */
export function authoredScenario(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision_refs: ["d-add"],
    kind: "behavior",
    split: "train",
    interface: "cli",
    steps: [
      {
        invoke: { argv: ["add", "milk"] },
        expect: { exit_code: 0, stdout_matches: { kind: "exact", text: "added milk\n" }, note: "adding prints the item" },
      },
    ],
    ...over,
  };
}

/** A multi-document YAML stream, as the author prints it. */
export function authoredYaml(...documents: Record<string, unknown>[]): string {
  return documents.map((document) => stringify(document)).join("---\n");
}

/** Counters written as fixed-width hex: ids differ, match their patterns, and are predictable in assertions. */
export function fakeIds(): Ids {
  let scenario = 0;
  let canary = 0;
  let seal = 0;
  const hex = (n: number, width: number): string => n.toString(16).padStart(width, "0");
  return {
    scenarioId: () => `s-${hex(++scenario, 32)}`,
    canary: () => `omf-canary-${hex(++canary, 32)}`,
    sealId: () => `seal-${hex(++seal, 16)}`,
  };
}

export function intakeContext(over: Partial<IntakeContext> = {}): IntakeContext {
  return { workId: WORK_ID, author: { ...AUTHOR }, ids: fakeIds(), ...over };
}
