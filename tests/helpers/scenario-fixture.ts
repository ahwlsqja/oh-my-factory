import { stringify } from "yaml";
import type { Ids, IntakeContext } from "../../src/scenario/intake.js";
import type { RunTarget, ScenarioRunner, StepInput } from "../../src/scenario/runner.js";
import type {
  AuthorStamp,
  Expect,
  ScenarioSplit,
  StepObservation,
  StoredKind,
  StoredScenario,
} from "../../src/scenario/types.js";

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

/** The stamp OMF copies from a session; lint compares every file's author with the seal event's. */
export const FAKE_AUTHOR: AuthorStamp = {
  vendor: "command",
  model: "stub",
  at: "2026-10-14T00:00:00.000Z",
  isolation: "host_command",
};

const hex32 = (n: number): string => n.toString(16).padStart(32, "0");

export type SeedExpect = Partial<Omit<Expect, "note">>;
/** One single-step scenario. `refs` defaults to d-interface for a behavior scenario and to none for a canary. */
export interface SeedSpec {
  split: ScenarioSplit;
  kind?: StoredKind;
  refs?: string[];
  expect: SeedExpect;
}

/** Fails both nulls: null-error exits 1, null-empty prints nothing. */
export const STRONG_EXPECT: SeedExpect = { exit_code: 0, stdout_matches: { kind: "exact", text: "ok\n" } };
/** Statically unsatisfiable (the exact text says ok is true, the json_path wants false), as lint requires. */
export const CANARY_SPEC: SeedSpec = {
  kind: "contradiction_canary",
  split: "train",
  expect: { stdout_matches: { kind: "exact", text: '{"ok":true}\n' }, json_path: { "$.ok": false } },
};
/** One strong behavior scenario per split, linked to the two linkable decisions, and one canary. */
export const DEFAULT_SPECS: readonly SeedSpec[] = [
  { split: "train", refs: ["d-interface"], expect: STRONG_EXPECT },
  { split: "test", refs: ["d-cache"], expect: STRONG_EXPECT },
  CANARY_SPEC,
];

/**
 * Stored scenarios as OMF's intake would stamp them. Ids and canaries are built at run time, so no full canary
 * literal sits in the repository. Every scenario has its own argv, so no two share an invoke prefix.
 */
export function buildScenarios(specs: readonly SeedSpec[], workId: string): StoredScenario[] {
  return specs.map((spec, index): StoredScenario => {
    const n = index + 1;
    const canary = `omf-canary-${hex32(n + 0xca0000)}`;
    const kind = spec.kind ?? "behavior";
    return {
      schema_version: 1,
      scenario_id: `s-${hex32(n)}`,
      work_id: workId,
      author: FAKE_AUTHOR,
      decision_refs: spec.refs ?? (kind === "behavior" ? ["d-interface"] : []),
      kind,
      split: spec.split,
      interface: "cli",
      steps: [
        {
          invoke: { argv: ["cache", "get", `key-${n}`], stdin: "" },
          expect: { exit_code: null, stdout_matches: null, json_path: null, ...spec.expect, note: `${canary} scenario ${n}` },
        },
      ],
      canary,
    };
  });
}

export interface FakeRunner {
  runner: ScenarioRunner;
  opened: RunTarget[];
  /** The most sessions that were open at the same time. */
  maxOpen(): number;
}
export interface FakeRunnerOptions {
  executes?: ScenarioRunner["executes"];
  delayMs?: number;
  /** openScenario throws, as an adapter that cannot make its scratch directory would. */
  failOpen?: boolean;
  observe?: (target: RunTarget, step: StepInput) => StepObservation;
}

/** What the three OMF fixtures do (null-error, null-empty, echo-everything), without spawning a process. */
function fixtureLike(target: RunTarget, step: StepInput): StepObservation {
  if (target.kind !== "fixture") return { outcome: "refused", code: "candidate_needs_container" };
  if (target.id === "null-error") return { outcome: "exited", exit_code: 1, stdout: "" };
  if (target.id === "null-empty") return { outcome: "exited", exit_code: 0, stdout: "" };
  return { outcome: "exited", exit_code: 0, stdout: `${step.argv.join(" ")}${step.stdin}` };
}

/** A `ScenarioRunner` double that records what was opened. Fast, for tests whose claim is not the fixtures themselves. */
export function fakeFixtureRunner(options: FakeRunnerOptions = {}): FakeRunner {
  const opened: RunTarget[] = [];
  const delay = options.delayMs ?? 0;
  let open = 0;
  let peak = 0;
  const runner: ScenarioRunner = {
    id: "fake-fixtures",
    executes: options.executes ?? "omf_fixture",
    async openScenario(target) {
      if (options.failOpen === true) throw new Error("no scratch directory");
      opened.push(target);
      open += 1;
      peak = Math.max(peak, open);
      return {
        async runStep(step) {
          if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
          return (options.observe ?? fixtureLike)(target, step);
        },
        async close() {
          open -= 1;
        },
      };
    },
  };
  return { runner, opened, maxOpen: () => peak };
}
