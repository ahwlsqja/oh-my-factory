import type { ProcessResult } from "../adapters/process-group.js";
import type { GitTarget } from "../git/hardened.js";

export type CommandResult = ProcessResult;
export interface RunOptions {
  timeoutMs: number;
  maxOutputBytes: number;
}

/**
 * Where a declared command runs. M3f: the container that holds the candidate. M3e: a test fixture target. No `src/` module
 * implements this by spawning on the host (a structural test enforces it).
 */
export interface CommandTarget {
  run(argv: readonly string[], options: RunOptions): Promise<CommandResult>;
}

/** A tree copy that can be reverted and thrown away. Created from a quarantine commit, never from the shared worktree. */
export interface WorkCopy extends CommandTarget {
  readonly id: string;
  /** Equals the tree of the sha it was created from. */
  isClean(): Promise<boolean>;
  applyPatch(patch: string, options: { reverse: boolean }): Promise<boolean>;
  dispose(): Promise<void>;
  /** Best-effort and synchronous, safe in a signal handler. */
  abortSync(): void;
}

export interface WorkCopyFactory {
  create(spec: { quarantine: GitTarget; sha: string }): Promise<WorkCopy>;
}
