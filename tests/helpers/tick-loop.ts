import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createReconciler } from "../../src/adapters/reconciler.js";
import { readConfig } from "../../src/core/config.js";
import { approveGoal } from "../../src/goal/approve.js";
import { type TickOptions, type TickResult, tickGoal } from "../../src/goal/tick.js";
import { type GoalFixture, setupGoal } from "./goal.js";
import { commitAll, makeTempDir } from "./tmp.js";

export const GOAL = "g-fast";
/** Distinctive canaries: they must never appear in CLI output (D29). */
export const TARGET = "3719.25";
export const MEASURED = "4817.39";
/** Titles the scripted model proposes, in order. No digits and no metric words, so seed lint accepts them. */
export const TITLES = [
  "Trim render work",
  "Reuse parsed templates",
  "Batch storage writes",
  "Skip unchanged rows",
  "Stream large responses",
  "Load heavy modules lazily",
];

const STUB = fileURLToPath(new URL("./tick-stub.mjs", import.meta.url));

export interface StubPlan {
  mode: "ok" | "empty" | "fail";
  /** Candidates per call in mode "ok" (default 1). */
  count?: number;
  /** affected_paths of every candidate (default ["src/render"], a normal-risk path). */
  paths?: string[];
  /** Sleep before answering, in milliseconds. */
  delay_ms?: number;
}

export interface LoopFixture extends GoalFixture {
  stubDir: string;
  /** Host runner, the scripted reconciler, the project's config and a clock that advances one second per read. */
  options: TickOptions;
}

export function setPlan(fx: Pick<LoopFixture, "stubDir">, plan: StubPlan): void {
  writeFileSync(join(fx.stubDir, "plan.json"), JSON.stringify({ ...plan, titles: TITLES }));
}

/** How many times the scripted model was called. */
export function stubCalls(fx: Pick<LoopFixture, "stubDir">): number {
  const file = join(fx.stubDir, "calls");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((line) => line !== "").length : 0;
}

/** Changes what `bench/p95.sh` prints. The value file is not a watched path, so this is not a regime change. */
export function setMeasured(fx: Pick<LoopFixture, "repo">, value: string): void {
  writeFileSync(join(fx.repo, "bench", "p95.value"), `${value}\n`);
}

function stepClock(stepMs = 1000): () => Date {
  let at = Date.now();
  return () => {
    at += stepMs;
    return new Date(at);
  };
}

/**
 * An approved build-mode goal g-fast: target m-p95 <= TARGET, `bench/p95.sh` prints the content of
 * `bench/p95.value` (MEASURED), only the script is watched, no guardrail, rounds budget 10, at most 2
 * open work items. With `stub: false` the project keeps its default config.toml (no `[reconciler]`
 * section) and the reconciler gets an empty environment, which is the default-config safety case.
 */
export function setupLoopGoal(options: { stub?: boolean } = {}): LoopFixture {
  const useStub = options.stub !== false;
  const fx = setupGoal({ guardrails: [] });
  writeFileSync(join(fx.repo, "bench", "p95.sh"), "cat bench/p95.value\n");
  writeFileSync(join(fx.repo, "bench", "p95.value"), `${MEASURED}\n`);
  writeFileSync(fx.goalFile, readFileSync(fx.goalFile, "utf8").replace("value: 250", `value: ${TARGET}`));
  commitAll(fx.repo, "loop bench");
  approveGoal(fx.location, GOAL, "human:dev");
  const stubDir = makeTempDir("omf-stub-");
  setPlan({ stubDir }, { mode: "ok", count: 1 });
  if (useStub) {
    const argv = JSON.stringify([process.execPath, STUB, stubDir]);
    appendFileSync(join(fx.location.dir, "config.toml"), `\n[reconciler]\nkind = "command"\ncommand = ${argv}\ntimeout_ms = 20000\n`);
  }
  const config = readConfig(fx.location.dir);
  const reconciler = createReconciler(fx.location.dir, config.reconciler, useStub ? process.env : {});
  return { ...fx, stubDir, options: { runner: "host", reconciler, config, now: stepClock() } };
}

export function runTick(fx: LoopFixture): Promise<TickResult> {
  return tickGoal(fx.location, GOAL, fx.options);
}

export async function waitFor(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
