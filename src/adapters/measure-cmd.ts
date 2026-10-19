import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDigestPinned } from "../container/image-ref.js";
import { safeText } from "../core/safe-text.js";
import { readGoalLock } from "../goal/goal-lock.js";
import { type MetricDefinition, readLock } from "../goal/metrics.js";
import { type ProcessResult, runProcessGroup } from "./process-group.js";

export type RunnerKind = "docker" | "host";
export type Isolation = "container" | "none";
/**
 * Why a metric has no number. A closed set: a failed, timed-out, denied, empty or unreadable measurement is
 * "unmeasured" with one of these codes. It is never a value and never counts as met.
 */
export const UNMEASURED_CODES = [
  "empty_command",
  "no_image",
  "could_not_run",
  "permission_denied",
  "timeout",
  "output_limit",
  "nonzero_exit",
  "killed_by_signal",
  "empty_output",
  "unparsable_output",
  "not_finite",
] as const;
export type UnmeasuredCode = (typeof UNMEASURED_CODES)[number];
export type MeasureOutcome = { ok: true; value: number } | { ok: false; code: UnmeasuredCode; reason: string };

/** The exit status a shell gives a command it found but may not execute. */
const EXIT_NOT_EXECUTABLE = 126;

export const MEASURE_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const NUMBER = /^-?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;

/**
 * The warning for a metric whose image is a tag, or null. A lock J1 approved before the digest rule keeps measuring,
 * but its tag can be re-pointed without a regime change, so every run says so.
 */
export function unpinnedImageWarning(metric: Pick<MetricDefinition, "metric_id" | "image">): string | null {
  if (metric.image === null || isDigestPinned(metric.image)) return null;
  return `warning: metric ${metric.metric_id} image ${safeText(metric.image)} is not pinned by digest and was locked before that was required, so the tag can be re-pointed without a regime change; propose the metric again with <name>@sha256:<digest>`;
}

/**
 * One warning per locked metric of the goal whose image is a tag. A goal that is not approved, or a lock that cannot
 * be read, gives none: the audit inside the measurement reports that problem itself, and a warning must not stop
 * or change a run.
 */
export function legacyImageWarnings(projectDir: string, goalId: string): string[] {
  const warnings: string[] = [];
  try {
    const goalLock = readGoalLock(projectDir, goalId);
    for (const metricId of goalLock?.metrics ?? []) {
      const lock = readLock(projectDir, goalId, metricId);
      const warning = lock === null ? null : unpinnedImageWarning(lock);
      if (warning !== null) warnings.push(warning);
    }
  } catch {
    return [];
  }
  return warnings;
}

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
  if (last === undefined) return { ok: false, code: "empty_output", reason: "the command printed nothing" };
  if (!NUMBER.test(last))
    return { ok: false, code: "unparsable_output", reason: "the last line of stdout is not a number" };
  const value = Number(last);
  if (!Number.isFinite(value)) return { ok: false, code: "not_finite", reason: "the value is not a finite number" };
  return { ok: true, value };
}

function outcomeOf(result: ProcessResult): MeasureOutcome {
  switch (result.kind) {
    case "error":
      return {
        ok: false,
        code: result.code === "EACCES" || result.code === "EPERM" ? "permission_denied" : "could_not_run",
        reason: `could not run: ${result.message}`,
      };
    case "timeout":
      return { ok: false, code: "timeout", reason: "timed out" };
    case "output_limit":
      return { ok: false, code: "output_limit", reason: `output exceeded ${MAX_OUTPUT_BYTES} bytes` };
    case "exited":
      if (result.status === null) {
        return { ok: false, code: "killed_by_signal", reason: `killed by ${result.signal ?? "a signal"}` };
      }
      if (result.status !== 0) {
        return {
          ok: false,
          code: result.status === EXIT_NOT_EXECUTABLE ? "permission_denied" : "nonzero_exit",
          reason: `exit code ${result.status}`,
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
  if (command.length === 0) return { ok: false, code: "empty_command", reason: "empty command" };
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
      code: "no_image",
      reason: `metric ${metric.metric_id} has no image; propose it with --image or measure with --runner host`,
    };
  }
  return runInDocker(metric.command, repo, metric.image, env);
}
