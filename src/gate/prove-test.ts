import { registerCleanup } from "../core/cleanup-registry.js";
import type { GitTarget } from "../git/hardened.js";
import { isAncestor, rawDiff, resolveCommit, revertPatch } from "../git/ops.js";
import { isTestPath } from "../work/risk.js";
import type { CommandResult, RunOptions, WorkCopy, WorkCopyFactory } from "./ports.js";

export type ProveStatus = "PROVEN" | "FAILED" | "MISCONFIGURED";
export type ProveReason =
  | "test-passed-without-fix"
  | "working-tree-not-clean"
  | "invalid-base-ref"
  | "base-not-ancestor"
  | "no-non-test-change"
  | "empty-revert-patch"
  | "revert-failed"
  | "baseline-test-failed"
  | "test-command-unrunnable"
  | "interrupted";

export interface ProveTestInput {
  quarantine: GitTarget;
  /** 40-hex shas. */
  base: string;
  head: string;
  /** The declared `interface.test_command`. */
  testCommand: readonly string[];
  /** Beyond `TEST_GLOBS`; the SAME array the audit receives (one field threaded by the sequencer). */
  explicitTestPaths: readonly string[];
  copies: WorkCopyFactory;
  timeoutMs?: number;
  /** Aborting stops the run between steps with `interrupted`; a signal to the process is handled by the cleanup registry. */
  signal?: AbortSignal;
}

/** Counts only. No path leaves this function: results and thrown messages carry none, because `HostGitError` messages are code plus exit status. */
export interface ProveTestResult {
  status: ProveStatus;
  reason: ProveReason | null;
  test_exit: number | null;
  non_test_paths: number;
  test_paths: number;
}

const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** A normal exit status is the only verdict a test run gives; a timeout, the output limit, a runner error or a signal is not one. */
function statusOf(result: CommandResult): number | null {
  return result.kind === "exited" ? result.status : null;
}

/** Creates a copy, registers its abort with the cleanup registry, and always disposes it (the copy is discarded, which is the restore). */
async function withCopy<T>(copies: WorkCopyFactory, spec: { quarantine: GitTarget; sha: string }, use: (copy: WorkCopy) => Promise<T>): Promise<T> {
  const copy = await copies.create(spec);
  const unregister = registerCleanup(() => copy.abortSync());
  try {
    return await use(copy);
  } finally {
    unregister();
    try {
      await copy.dispose();
    } catch {
      copy.abortSync();
    }
  }
}

/**
 * Proves that the change's test fails without the change. Flow: resolve both shas, check ancestry, split the raw diff
 * into test and non-test paths, build the revert patch for the non-test paths. Copy A (head) runs the test command as a baseline;
 * copy B is a second, fresh copy of head, with the patch applied in reverse, and must make the test fail. Two copies, because a
 * build output, cache or snapshot from the baseline must not reach the reverted run.
 */
export async function proveTest(input: ProveTestInput): Promise<ProveTestResult> {
  const counts = { non_test_paths: 0, test_paths: 0 };
  const result = (status: ProveStatus, reason: ProveReason | null, test_exit: number | null = null): ProveTestResult => ({ status, reason, test_exit, ...counts });
  const stop = (reason: ProveReason, test_exit: number | null = null): ProveTestResult => result("MISCONFIGURED", reason, test_exit);
  const aborted = (): boolean => input.signal?.aborted === true;

  if (aborted()) return stop("interrupted");
  const [base, head] = await Promise.all([resolveCommit(input.quarantine, input.base), resolveCommit(input.quarantine, input.head)]);
  if (base === null || head === null) return stop("invalid-base-ref");
  if (!(await isAncestor(input.quarantine, input.base, input.head))) return stop("base-not-ancestor");

  const nonTest: string[] = [];
  for (const entry of await rawDiff(input.quarantine, input.base, input.head)) {
    if (isTestPath(entry.path, input.explicitTestPaths)) counts.test_paths += 1;
    else nonTest.push(entry.path);
  }
  counts.non_test_paths = nonTest.length;
  if (nonTest.length === 0) return stop("no-non-test-change");
  const patch = await revertPatch(input.quarantine, input.base, input.head, nonTest);
  if (patch.length === 0) return stop("empty-revert-patch");

  const spec = { quarantine: input.quarantine, sha: input.head };
  const options: RunOptions = { timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES };

  const baseline = await withCopy(input.copies, spec, async (copy): Promise<ProveTestResult | null> => {
    if (!(await copy.isClean())) return stop("working-tree-not-clean");
    const status = statusOf(await copy.run(input.testCommand, options));
    if (status === null) return stop("test-command-unrunnable");
    return status === 0 ? null : stop("baseline-test-failed", status);
  });
  if (baseline !== null) return baseline;
  if (aborted()) return stop("interrupted");

  return withCopy(input.copies, spec, async (copy) => {
    if (!(await copy.isClean())) return stop("working-tree-not-clean");
    if (!(await copy.applyPatch(patch, { reverse: true }))) return stop("revert-failed");
    const status = statusOf(await copy.run(input.testCommand, options));
    if (status === null) return stop("test-command-unrunnable");
    return status === 0 ? result("FAILED", "test-passed-without-fix", 0) : result("PROVEN", null, status);
  });
}
