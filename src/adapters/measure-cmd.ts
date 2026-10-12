import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MetricDefinition } from "../goal/metrics.js";

export type RunnerKind = "docker" | "host";
export type Isolation = "container" | "none";
export type MeasureOutcome = { ok: true; value: number } | { ok: false; reason: string };

export const MEASURE_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const NUMBER = /^-?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;

export function isolationOf(runner: RunnerKind): Isolation {
  return runner === "docker" ? "container" : "none";
}

/**
 * A measure command prints its value on the last non-empty stdout line. Anything else fails: empty means
 * fail. Output is untrusted data and is never interpreted beyond this parse (spec §4.2).
 */
export function parseMeasurement(stdout: string): MeasureOutcome {
  const last = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  if (last === undefined) return { ok: false, reason: "the command printed nothing" };
  if (!NUMBER.test(last)) return { ok: false, reason: "the last line of stdout is not a number" };
  return { ok: true, value: Number(last) };
}

function outcomeOf(result: SpawnSyncReturns<string>): MeasureOutcome {
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === "ETIMEDOUT" ? "timed out" : `could not run: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return { ok: false, reason: result.status === null ? `killed by ${result.signal ?? "a signal"}` : `exit code ${result.status}` };
  }
  return parseMeasurement(result.stdout);
}

/**
 * Runs the command on the host, without isolation; callers label the result "none". The child gets only
 * PATH, a throwaway HOME and TMPDIR, and the C locale, so credentials in the caller's environment do not
 * reach it.
 */
export function runOnHost(
  command: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = MEASURE_TIMEOUT_MS,
): MeasureOutcome {
  const [program, ...args] = command;
  if (program === undefined) return { ok: false, reason: "empty command" };
  const scratch = mkdtempSync(join(tmpdir(), "omf-measure-"));
  try {
    const result = spawnSync(program, args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: MAX_OUTPUT_BYTES,
      env: { PATH: env.PATH ?? "/usr/bin:/bin", HOME: scratch, TMPDIR: scratch, LC_ALL: "C" },
    });
    return outcomeOf(result);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Argv for a disposable, network-less container with the repository mounted read-only (spec §4.2). */
export function dockerArgs(command: readonly string[], repo: string, image: string, name: string): string[] {
  return [
    "run",
    "--rm",
    "--name",
    name,
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--volume",
    `${repo}:/work:ro`,
    "--workdir",
    "/work",
    "--env",
    "HOME=/tmp",
    "--env",
    "LC_ALL=C",
    image,
    ...command,
  ];
}

export function runInDocker(
  command: readonly string[],
  repo: string,
  image: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = MEASURE_TIMEOUT_MS,
): MeasureOutcome {
  const name = `omf-measure-${randomUUID().slice(0, 8)}`;
  const result = spawnSync("docker", dockerArgs(command, repo, image, name), {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: MAX_OUTPUT_BYTES,
    env,
  });
  // Killing the docker client does not stop the container, so remove it by name.
  if (result.error !== undefined) spawnSync("docker", ["rm", "--force", name], { stdio: "ignore", env, timeout: 30_000 });
  return outcomeOf(result);
}

export function runMeasurement(
  metric: MetricDefinition,
  repo: string,
  runner: RunnerKind,
  env: NodeJS.ProcessEnv = process.env,
): MeasureOutcome {
  if (runner === "host") return runOnHost(metric.command, repo, env);
  if (metric.image === null) {
    return { ok: false, reason: `metric ${metric.metric_id} has no image; propose it with --image or measure with --runner host` };
  }
  return runInDocker(metric.command, repo, metric.image, env);
}
