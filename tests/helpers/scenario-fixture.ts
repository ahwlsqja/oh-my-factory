import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { runDecideAdd, runDecideResolve } from "../../src/cli/decide.js";
import { decisionsDigest, foldDecisions } from "../../src/decision/state.js";
import type { Gate2Context, Gate2Reason, Gate2Result } from "../../src/scenario/gate2.js";
import { type SetRef, type Vault, openVault, setDir, writeScenarioSet } from "../../src/vault/vault.js";
import { HUMAN, NOW, type DecisionFixture, addOpen, closeInterface, resolveOpen, setupDecisionItem } from "./decision-fixture.js";
import { recordW } from "./work.js";
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
export function fixtureOf(target: RunTarget, step: StepInput): StepObservation {
  return fixtureLike(target, step);
}
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

export interface SealedItem {
  f: DecisionFixture;
  vault: Vault;
  ref: SetRef;
  sealId: string;
  setSha256: string;
  scenarios: StoredScenario[];
}
export interface SealedOptions {
  /** Also resolve a quantitative decision, so GATE-2 lists it as not_run. */
  latency?: boolean;
  /** false: the item is ready for GATE-2 but nothing was sealed. */
  seal?: boolean;
  /** Record `work.started` before `seal.completed`: the judge was written after the implementation began. */
  startBeforeSeal?: boolean;
}

/** `scenarioFile(s, i)`: the vault file of the i-th seeded scenario. */
export function scenarioFile(s: SealedItem, index: number): string {
  const scenario = s.scenarios[index];
  if (scenario === undefined) throw new Error(`no seeded scenario ${index}`);
  return join(setDir(s.vault, s.ref), `${scenario.scenario_id}.yaml`);
}

/**
 * A `ready` item whose decisions d-interface and d-cache are resolved (GATE-1 passes), with `specs` written to the
 * vault and pinned by a `seal.completed` event. The event is appended by hand, in the payload shape of skeleton
 * section 4, so this needs no seal stage (T10).
 */
export function seedSealedItem(specs: readonly SeedSpec[] = DEFAULT_SPECS, options: SealedOptions = {}): SealedItem {
  const f = setupDecisionItem();
  closeInterface(f);
  addOpen(f, "d-cache", "compatibility");
  resolveOpen(f, "d-cache");
  if (options.latency === true) {
    runDecideAdd(f.fx.location, f.workId, { id: "d-latency", class: "latency", question: "How fast must a lookup be?" }, "omf");
    runDecideResolve(
      f.fx.location,
      f.workId,
      "d-latency",
      {
        choice: "Bounded lookup time",
        rationale: "Callers wait on it.",
        rejected: [],
        response_measure: { metric: "cache lookup time", op: "<=", threshold: 40, unit: "ms", percentile: 95, window: null },
      },
      HUMAN,
    );
  }
  const scenarios = buildScenarios(specs, f.workId);
  const vault = openVault(f.fx.location, f.fx.env);
  const sealId = `seal-${"1".padStart(16, "0")}`;
  const ref: SetRef = { work_id: f.workId, seal_id: sealId };
  const sealed: SealedItem = { f, vault, ref, sealId, setSha256: "", scenarios };
  if (options.seal === false) return sealed;

  // No decision write may follow work.started: the item file would lag the ledger and the decide verbs would refuse.
  if (options.startBeforeSeal === true) recordW(f.fx.ledger, "work.started", f.item);
  const written = writeScenarioSet(vault, ref, scenarios);
  const count = (pick: (s: StoredScenario) => boolean): number => scenarios.filter(pick).length;
  f.fx.ledger.append({
    actor: "omf",
    type: "seal.completed",
    payload: {
      goal_id: f.scope.goal_id,
      work_id: f.scope.work_id,
      round: 1,
      seal_id: sealId,
      author: FAKE_AUTHOR,
      decisions_digest: decisionsDigest(foldDecisions(f.fx.ledger.readVerified(), f.scope)),
      set_sha256: written.set_sha256,
      counts: {
        authored: scenarios.length,
        stored: scenarios.length,
        behavior: count((s) => s.kind === "behavior"),
        contradiction_canary: count((s) => s.kind === "contradiction_canary"),
        train: count((s) => s.split === "train"),
        test: count((s) => s.split === "test"),
        rejected: 0,
        ignored_fields: 0,
      },
      rejected_by_code: {},
    },
  });
  return { ...sealed, setSha256: written.set_sha256 };
}

/** The GATE-2 context for a sealed item at the fixed test clock. The default runner is the fast double; pass `runner` to override. */
export function sealedCtx(s: SealedItem, over: Partial<Gate2Context> = {}): Gate2Context {
  return {
    location: s.f.fx.location,
    item: s.f.item,
    now: NOW,
    runner: fakeFixtureRunner().runner,
    vault: s.vault,
    env: s.f.fx.env,
    ...over,
  };
}

export function gate2Reasons(result: Gate2Result): Gate2Reason[] {
  return result.status === "pass" ? [] : result.reasons;
}

/** Writes `text` at `file`, creating the parent directories. For planting material inside the repository. */
export function plant(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
