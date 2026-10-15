import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MetricDefinition } from "../goal/metrics.js";
import { type ProcessResult, runProcessGroup } from "./process-group.js";

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
  const value = Number(last);
  if (!Number.isFinite(value)) return { ok: false, reason: "the value is not a finite number" };
  return { ok: true, value };
}

function outcomeOf(result: ProcessResult): MeasureOutcome {
  switch (result.kind) {
    case "error":
      return { ok: false, reason: `could not run: ${result.message}` };
    case "timeout":
      return { ok: false, reason: "timed out" };
    case "output_limit":
      return { ok: false, reason: `output exceeded ${MAX_OUTPUT_BYTES} bytes` };
    case "exited":
      if (result.status !== 0) {
        return {
          ok: false,
          reason: result.status === null ? `killed by ${result.signal ?? "a signal"}` : `exit code ${result.status}`,
        };
      }
      return parseMeasurement(result.stdout);
  }
}

/**
 * Runs the command on the host, without isolation; callers label the result "none". The child gets only
 * PATH, a throwaway HOME and TMPDIR, and the C locale, so credentials in the caller's environment do not
 * reach it. It runs in its own process group and the whole group is killed when the command ends, so a
 * background process it started does not outlive the measurement.
 */
export async function runOnHost(
  command: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = MEASURE_TIMEOUT_MS,
): Promise<MeasureOutcome> {
  if (command.length === 0) return { ok: false, reason: "empty command" };
  const scratch = mkdtempSync(join(tmpdir(), "omf-measure-"));
  try {
    const result = await runProcessGroup(command, {
      cwd,
      env: { PATH: env.PATH ?? "/usr/bin:/bin", HOME: scratch, TMPDIR: scratch, LC_ALL: "C" },
      timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
    return outcomeOf(result);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * An image reference becomes one argv element of `docker run`, directly before the command. A value that
 * starts with "-" would be read as a docker option (`--privileged`, `-v /:/host`) and one with whitespace is
 * not a reference at all. The metric schemas enforce the same rule when a metric is proposed or locked; this
 * is the guard of last resort for a caller that did not go through them (spec §4.2).
 */
export function isValidImage(image: string): boolean {
  return /^[^\s-]\S*$/.test(image);
}

/** Argv for a disposable, network-less container with the repository mounted read-only (spec §4.2). */
export function dockerArgs(command: readonly string[], repo: string, image: string, name: string): string[] {
  if (!isValidImage(image))
    throw new Error('invalid image reference: it must not start with "-" or contain whitespace');
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

export async function runInDocker(
  command: readonly string[],
  repo: string,
  image: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = MEASURE_TIMEOUT_MS,
): Promise<MeasureOutcome> {
  const name = `omf-measure-${randomUUID().slice(0, 8)}`;
  const result = await runProcessGroup(["docker", ...dockerArgs(command, repo, image, name)], {
    cwd: repo,
    env,
    timeoutMs,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });
  // Killing the docker client does not stop the container, so remove it by name.
  if (result.kind !== "exited") {
    await runProcessGroup(["docker", "rm", "--force", name], {
      cwd: repo,
      env,
      timeoutMs: 30_000,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
  }
  return outcomeOf(result);
}

export async function runMeasurement(
  metric: MetricDefinition,
  repo: string,
  runner: RunnerKind,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MeasureOutcome> {
  if (runner === "host") return runOnHost(metric.command, repo, env);
  if (metric.image === null) {
    return {
      ok: false,
      reason: `metric ${metric.metric_id} has no image; propose it with --image or measure with --runner host`,
    };
  }
  return runInDocker(metric.command, repo, metric.image, env);
}
