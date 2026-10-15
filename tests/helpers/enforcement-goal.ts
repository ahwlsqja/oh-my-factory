import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReconcileOutcome, Reconciler } from "../../src/adapters/reconciler.js";
import { declareBudget } from "../../src/core/budget.js";
import { Ledger, type LedgerEvent } from "../../src/core/ledger.js";
import { type ProjectLocation, resolveProject } from "../../src/core/paths.js";
import { writePrivateFile } from "../../src/core/private-fs.js";
import { initProject } from "../../src/core/project.js";
import { approveGoal } from "../../src/goal/approve.js";
import { bandsFile } from "../../src/goal/bands.js";
import { goalDir, goalFile } from "../../src/goal/goal-file.js";
import { proposeMetric } from "../../src/goal/metrics.js";
import { CANARY, CLEAN_CANDIDATE } from "./canary.js";
import { omf } from "./cli.js";
import { readTree } from "./tree.js";
import { commitAll, makeGitRepo, makeTempDir } from "./tmp.js";

const STUB = fileURLToPath(new URL("./reconciler-stub.mjs", import.meta.url));

export const GOAL_ID = "g-checkout";
export const TARGET_METRIC = CANARY.metricId;
export const GUARDRAIL_METRIC = "m-errors";

const DEFAULTS = {
  goalId: GOAL_ID as string,
  objective: "Make the checkout page respond faster",
  approach: "Move expensive work off the request path.",
  /** Outside `## Approach`, so it must never reach the model (spec §4.6). */
  notes: `Current p95 is ${CANARY.reading} ms and the target is ${CANARY.target} ms.`,
  /** What `bench/reading.txt` holds, and so what the target metric prints. */
  reading: CANARY.reading as string | number,
  /** The target is `<= target`. */
  target: Number(CANARY.target),
  rounds: 5,
  maxOpen: 5,
  wallTime: "72h",
  minObservation: "7d",
  /** `bands`: m-errors is a guardrail with a bands file; `no-bands`: a guardrail with none; `none`: no guardrail. */
  guardrail: "none" as "none" | "bands" | "no-bands",
  baseline: "rolling_30d",
};

export type EnforcementOptions = Partial<typeof DEFAULTS> & {
  /** When set, a person declares a disclosure budget of this size after approval (D6). */
  disclosure?: number;
};

export interface EnforcementFixture {
  repo: string;
  /** HOME for CLI runs; OMF state is under `<home>/.omf`, where the library calls look too. */
  home: string;
  env: NodeJS.ProcessEnv;
  location: ProjectLocation;
  ledger: Ledger;
  goalId: string;
  /** `<project>/goals/<goal_id>` */
  goalPath: string;
  /** Where the reconciler stub records stdin, argv and env; owned by the test, not by the scratch dir. */
  record: string;
  /** The `config.toml` that `omf init` wrote; `useStub` appends a `[reconciler]` section to it. */
  baseConfig: string;
}

function goalText(o: typeof DEFAULTS): string {
  const guardrails = o.guardrail === "none" ? "" : GUARDRAIL_METRIC;
  return `---
schema_version: 1
goal_id: ${o.goalId}
title: "Faster checkout"
mode: build
kind: default
objective: ${JSON.stringify(o.objective)}
target:
  metric_id: ${TARGET_METRIC}
  operator: "<="
  value: ${o.target}
  unit: ms
leading: []
lagging: [${TARGET_METRIC}]
link_hypothesis: "Less work before the first response makes the page faster"
guardrails: [${guardrails}]
prereg:
  min_observation: ${o.minObservation}
  decision_rule: "target met for 2 consecutive measurements and no guardrail breach"
  metrics_judged: 1
budget:
  rounds: ${o.rounds}
  wall_time: ${o.wallTime}
  max_open_work_items: ${o.maxOpen}
state_source: markdown
---
## Approach

${o.approach}

## Notes

${o.notes}
`;
}

/**
 * An initialized project with an approved build-mode goal `g-checkout`. The target metric
 * `m-zebra-quokka` runs `sh bench/canary-qwerty.sh`, which prints the contents of `bench/reading.txt`; only
 * the script is watched, so changing the reading is not a regime change. With a guardrail, `m-errors`
 * prints a constant 0.4. Nothing in the fixture talks to a real model: call `useStub` (or one of the
 * `use*Model` helpers) before ticking.
 */
export function setupEnforcementGoal(options: EnforcementOptions = {}): EnforcementFixture {
  const o = { ...DEFAULTS, ...options };
  const repo = makeGitRepo();
  const home = makeTempDir("omf-home-");
  const env = { OMF_HOME: join(home, ".omf") };
  initProject(repo, env);
  const location = resolveProject(repo, env);

  mkdirSync(join(repo, "bench"), { recursive: true });
  writeFileSync(join(repo, CANARY.watchedPath), "cat bench/reading.txt\n");
  writeFileSync(join(repo, "bench", "reading.txt"), `${o.reading}\n`);
  writeFileSync(join(repo, "bench", "errors.sh"), "cat bench/errors.txt\n");
  writeFileSync(join(repo, "bench", "errors.txt"), "0.4\n");
  commitAll(repo, "add bench");

  writePrivateFile(goalFile(location.dir, o.goalId), goalText(o));
  const ledger = new Ledger(location.dir);
  proposeMetric(
    ledger,
    location.dir,
    {
      metric_id: TARGET_METRIC,
      command: ["sh", CANARY.watchedPath],
      unit: "ms",
      watched_paths: [CANARY.watchedPath],
      image: null,
    },
    "human:dev",
  );
  if (o.guardrail !== "none") {
    proposeMetric(
      ledger,
      location.dir,
      { metric_id: GUARDRAIL_METRIC, command: ["sh", "bench/errors.sh"], unit: "%", watched_paths: [], image: null },
      "human:dev",
    );
  }
  if (o.guardrail === "bands") {
    // The bands file is part of what J1 locks, so it exists before the approval.
    writePrivateFile(
      bandsFile(location.dir, o.goalId, GUARDRAIL_METRIC),
      `metric: ${GUARDRAIL_METRIC}\nbaseline: ${o.baseline}\nrules: western_electric\ntiers:\n  3sigma:\n    action: log\n`,
    );
  }
  approveGoal(location, o.goalId, "human:dev");
  if (options.disclosure !== undefined) declareBudget(ledger, o.goalId, "disclosure", options.disclosure, "human:dev");

  return {
    repo,
    home,
    env,
    location,
    ledger,
    goalId: o.goalId,
    goalPath: goalDir(location.dir, o.goalId),
    record: makeTempDir("omf-rec-"),
    baseConfig: readFileSync(join(location.dir, "config.toml"), "utf8"),
  };
}

/** Points the `command` reconciler at `reconciler-stub.mjs <mode> <record> <args...>`. Replaces any earlier choice. */
export function useStub(fx: EnforcementFixture, mode: string, ...args: string[]): void {
  const command = [process.execPath, STUB, mode, fx.record, ...args];
  const section = `\n[reconciler]\nkind = "command"\ncommand = [${command.map((arg) => JSON.stringify(arg)).join(", ")}]\n`;
  writeFileSync(join(fx.location.dir, "config.toml"), `${fx.baseConfig}${section}`);
}

/** Writes a JSON fixture into the record directory and returns its path. */
function writeRecord(fx: EnforcementFixture, name: string, data: unknown): string {
  const file = join(fx.record, name);
  writeFileSync(file, JSON.stringify(data));
  return file;
}

/** A model that answers every call with exactly these candidates. */
export function useCandidates(fx: EnforcementFixture, candidates: readonly unknown[]): void {
  useStub(fx, "print", writeRecord(fx, "response.json", { candidates }));
}

/** A model that answers every call with the one clean candidate. */
export function useCleanModel(fx: EnforcementFixture): void {
  useCandidates(fx, [CLEAN_CANDIDATE]);
}

export type LeakChannel = "text" | "paths" | "threshold" | "nested-query";

/** A model that plants the canaries in the given channel (see `reconciler-stub.mjs`). */
export function useLeakyModel(fx: EnforcementFixture, channel: LeakChannel): void {
  const canaries = writeRecord(fx, "canaries.json", {
    value: CANARY.reading,
    target: CANARY.target,
    metric_id: CANARY.metricId,
  });
  useStub(fx, "leaky", canaries, channel);
}

/** Changes what the target metric prints. The script is watched; the reading file is not. */
export function setReading(fx: EnforcementFixture, value: number | string): void {
  writeFileSync(join(fx.repo, "bench", "reading.txt"), `${value}\n`);
}

/** `omf goal tick <goal> --runner host [...extra]` in a child process, as cron would run it. */
export function tickCli(
  fx: EnforcementFixture,
  extra: string[] = [],
): { code: number; stdout: string; stderr: string } {
  return omf(["goal", "tick", fx.goalId, "--runner", "host", ...extra], fx.repo, fx.home);
}

/** Verified ledger events, optionally of one type. A fresh `Ledger` each time: the same thing a restarted process sees. */
export function ledgerEvents(fx: EnforcementFixture, type?: string): LedgerEvent[] {
  const all = new Ledger(fx.location.dir).readVerified();
  return type === undefined ? all : all.filter((event) => event.type === type);
}

/** The JSON of every payload of the given event types, one per line, for a single search. */
export function payloadText(fx: EnforcementFixture, ...types: string[]): string {
  return ledgerEvents(fx)
    .filter((event) => types.includes(event.type))
    .map((event) => JSON.stringify(event.payload))
    .join("\n");
}

/** The texts of `goals/<g>/reconcile/*.<kind>.json`, in file name order. */
export function reconcileTexts(fx: EnforcementFixture, kind: "input" | "output"): string[] {
  return [...readTree(join(fx.goalPath, "reconcile"))]
    .filter(([name]) => name.endsWith(`.${kind}.json`))
    .map(([, text]) => text);
}

/** The parsed `ReconcilerInput` of every tick that called the model. File order is by tick id, which is not call order within one second. */
export function reconcileInputs(fx: EnforcementFixture): Record<string, unknown>[] {
  return reconcileTexts(fx, "input").map((text) => JSON.parse(text) as Record<string, unknown>);
}

/** A reconciler that fails every call and counts them, for ticks that must not reach the model. */
export function unusedModel(): { reconciler: Reconciler; calls: () => number } {
  let calls = 0;
  const reconciler: Reconciler = {
    id: "unused",
    isolation: "host-tool-less",
    run: async (): Promise<ReconcileOutcome> => {
      calls += 1;
      return { ok: false, code: "misconfigured", reason: "this test expects no model call", durationMs: 0 };
    },
  };
  return { reconciler, calls: () => calls };
}
