import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDecideAdd, runDecideResolve } from "../../src/cli/decide.js";
import type { Gate2StepContext } from "../../src/scenario/gate2-adapter.js";
import { createHostFixtureRunner } from "../../src/scenario/fixtures.js";
import type { Ids } from "../../src/scenario/intake.js";
import type { ScenarioRunner } from "../../src/scenario/runner.js";
import type { SealFeedback } from "../../src/scenario/types.js";
import { type SealDeps, runSealStage } from "../../src/seal/seal.js";
import { createCommandAuthor } from "../../src/seal/session.js";
import { assertLineSafe } from "../../src/vault/line-guard.js";
import { type Vault, openVault, setDir } from "../../src/vault/vault.js";
import { newRunId, wEvent } from "../../src/work/w-events.js";
import {
  type DecisionFixture,
  HUMAN,
  NOW,
  addOpen,
  closeInterface,
  resolveOpen,
  setupDecisionItem,
} from "./decision-fixture.js";

const AUTHOR_STUB = fileURLToPath(new URL("./line-author-stub.mjs", import.meta.url));
const PROMPT_END = "\n=====PROMPT-END=====\n";

/** Strings only the planted scenarios hold: the E2 test looks for them on every surface a scenario must not reach. */
export const SCENARIO_TEXT = ["zz-distinct-key", "UNIQUE-NOTE-PHRASE", "ok-distinct-output"] as const;

/** Fixed, unique ids that match the real patterns (`s-<32 hex>`, `omf-canary-<32 hex>`, `seal-<16 hex>`). */
export function countingIds(): Ids {
  let n = 0;
  const hex = (width: number): string => {
    n += 1;
    return n.toString(16).padStart(width, "0");
  };
  return { scenarioId: () => `s-${hex(32)}`, canary: () => `omf-canary-${hex(32)}`, sealId: () => `seal-${hex(16)}` };
}

export interface LineFixture {
  f: DecisionFixture;
  vault: Vault;
  ids: Ids;
  runner: ScenarioRunner;
  /** Where `writeYaml` puts author outputs; outside the repository and the host state. */
  yamlDir: string;
  promptLog: string;
}

/**
 * An item whose GATE-1 passes: the interface decision, one resolved compatibility decision (`d-cache`) and one
 * resolved quantitative decision (`d-latency`, exempt from the link rule). `decisions: false` leaves it with none.
 */
export function setupLine(options: { decisions?: boolean } = {}): LineFixture {
  const f = setupDecisionItem();
  if (options.decisions ?? true) {
    closeInterface(f);
    addOpen(f, "d-cache", "compatibility");
    resolveOpen(f, "d-cache");
    runDecideAdd(
      f.fx.location,
      f.workId,
      { id: "d-latency", class: "latency", question: "How fast must a lookup be?" },
      "omf",
    );
    runDecideResolve(
      f.fx.location,
      f.workId,
      "d-latency",
      {
        choice: "Bounded lookup time",
        rationale: "Callers wait on it.",
        rejected: [],
        response_measure: {
          metric: "cache lookup time",
          op: "<=",
          threshold: 40,
          unit: "ms",
          percentile: 95,
          window: null,
        },
      },
      HUMAN,
    );
  }
  return {
    f,
    vault: openVault(f.fx.location, f.fx.env),
    ids: countingIds(),
    runner: createHostFixtureRunner(),
    yamlDir: f.fx.record,
    promptLog: join(f.fx.record, "prompts.log"),
  };
}

export interface ScenarioSpec {
  refs: string[];
  split: "train" | "test";
  kind?: "behavior" | "contradiction_canary";
  argv: string[];
  expect: Record<string, unknown>;
}

const OK = { exit_code: 0, stdout_matches: { kind: "exact", text: "ok-distinct-output\n" } };

/** Fails both null implementations: exit 0 is wrong for null-error, the exact stdout is wrong for null-empty. */
export function behavior(refs: string[], split: "train" | "test", key: string): ScenarioSpec {
  return { refs, split, argv: ["cache", "get", key], expect: OK };
}

/** Statically unsatisfiable: a plain-text stdout that must also be JSON with `$.hit` (lint `canary_satisfiable`). */
export function canaryScenario(split: "train" | "test"): ScenarioSpec {
  return {
    refs: [],
    split,
    kind: "contradiction_canary",
    argv: ["cache", "get", "zz-distinct-key"],
    expect: { exit_code: 0, stdout_matches: { kind: "exact", text: "plain\n" }, json_path: { "$.hit": true } },
  };
}

/** The multi-document YAML an author prints. Each document is written as JSON, which is valid YAML. */
export function authoredYaml(specs: readonly ScenarioSpec[]): string {
  return specs
    .map((s) =>
      JSON.stringify({
        decision_refs: s.refs,
        kind: s.kind ?? "behavior",
        split: s.split,
        interface: "cli",
        steps: [{ invoke: { argv: s.argv, stdin: "" }, expect: { ...s.expect, note: "UNIQUE-NOTE-PHRASE" } }],
      }),
    )
    .join("\n---\n");
}

/** Round 1 links `d-interface` only, so GATE-2 sends the item back for `d-cache`. Round 2 adds the missing link. */
export const ROUND1: readonly ScenarioSpec[] = [
  behavior(["d-interface"], "train", "zz-distinct-key"),
  behavior(["d-interface"], "test", "k2"),
  canaryScenario("train"),
];
export const ROUND2: readonly ScenarioSpec[] = [...ROUND1, behavior(["d-cache"], "train", "k3")];

export function writeYaml(l: LineFixture, name: string, specs: readonly ScenarioSpec[]): string {
  const file = join(l.yamlDir, name);
  writeFileSync(file, authoredYaml(specs));
  return file;
}

/** The deps of one S2 station run with the stub author printing `yamlPath`. No `preflight`: the stage functions of M3c get theirs from T11's station. */
export function sealDeps(l: LineFixture, yamlPath: string, feedback?: SealFeedback): Omit<SealDeps, "preflight"> {
  return {
    location: l.f.fx.location,
    item: l.f.item,
    session: createCommandAuthor({
      command: [process.execPath, AUTHOR_STUB, yamlPath, l.promptLog],
      timeoutMs: 20_000,
    }),
    ledger: l.f.fx.ledger,
    vault: l.vault,
    now: () => NOW,
    ids: l.ids,
    timeoutMs: 20_000,
    ...(feedback === undefined ? {} : { feedback }),
  };
}

/** `sealDeps` plus what a whole pass needs. Structurally a `LinePassDeps`. */
export function passDeps(
  l: LineFixture,
  yamlPath: string,
  feedback?: SealFeedback,
): Omit<SealDeps, "preflight"> & { runner: ScenarioRunner; env: NodeJS.ProcessEnv } {
  return { ...sealDeps(l, yamlPath, feedback), runner: l.runner, env: l.f.fx.env };
}

/** Runs the stage directly (guarded the same way as the station) and returns the new seal id. */
export async function sealStored(l: LineFixture, yamlPath: string): Promise<string> {
  const { location } = l.f.fx;
  const stage = await runSealStage({ ...sealDeps(l, yamlPath), preflight: () => assertLineSafe(location, l.f.fx.env) });
  if (stage.status !== "stored") throw new Error(`expected a stored seal, got ${stage.status}`);
  return stage.seal_id;
}

export function gate2Ctx(l: LineFixture): Gate2StepContext {
  const { location } = l.f.fx;
  return {
    location,
    item: l.f.item,
    now: NOW,
    runner: l.runner,
    vault: l.vault,
    env: l.f.fx.env,
    ledger: l.f.fx.ledger,
    preflight: () => assertLineSafe(location, l.f.fx.env),
  };
}

/** The prompts the stub author received, in call order. Empty when it was never called. */
export function prompts(l: LineFixture): string[] {
  if (!existsSync(l.promptLog)) return [];
  return readFileSync(l.promptLog, "utf8")
    .split(PROMPT_END)
    .filter((p) => p.length > 0);
}

/** A forged-free `work.started` as M3b1 writes it (actor `omf`), leaving item.md alone: the state of a run killed after its start. */
export function appendWorkStarted(l: LineFixture): void {
  const scope = { goal_id: l.f.scope.goal_id, work_id: l.f.workId, run_id: newRunId(NOW, () => "0000") };
  l.f.fx.ledger.append(wEvent({ type: "work.started", payload: { ...scope, from: "ready" } }));
}

/** Changes one scenario's expected output on disk, so the set no longer matches its `set_sha256`. */
export function tamperSet(l: LineFixture, sealId: string): void {
  const dir = setDir(l.vault, { work_id: l.f.workId, seal_id: sealId });
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name);
    const text = readFileSync(file, "utf8");
    if (!text.includes("ok-distinct-output")) continue;
    writeFileSync(file, text.replace("ok-distinct-output", "ok-changed-output"));
    return;
  }
  throw new Error("no scenario file holds the expected output");
}

/** A canary-shaped string in a repository file, built at run time (M3c-D13). */
export function plantCanary(repo: string): void {
  writeFileSync(join(repo, "notes.txt"), `leftover omf-canary-${"ab".repeat(16)}\n`);
}
