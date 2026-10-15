import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { assertOutsideAgentHomes } from "../../src/core/paths.js";
import type { CommandResult, CommandTarget, RunOptions, WorkCopy, WorkCopyFactory } from "../../src/gate/ports.js";
import { type GitTarget, createScratchGitDir } from "../../src/git/hardened.js";
import { applyPatchToDir, exportTree, isDirClean } from "../../src/git/ops.js";
import { isAlive } from "./process.js";

export interface TempWorkCopyOptions {
  /** Absolute, outside the repository and the agent homes (a test temp dir). */
  parent: string;
  /** Required; supplied only by tests in M3e. No default, so this adapter cannot run code by itself. */
  exec: (copyRoot: string) => CommandTarget;
}

/** A copy of one quarantine commit in `<parent>/wc-<pid>-<hex8>`; a scratch git dir and a private index live in `<same>-s`. */
class TempWorkCopy implements WorkCopy {
  private readonly target: CommandTarget;

  constructor(
    readonly id: string,
    readonly root: string,
    private readonly holder: string,
    private readonly scratchGitDir: string,
    private readonly quarantine: GitTarget,
    private readonly sha: string,
    exec: (copyRoot: string) => CommandTarget,
  ) {
    this.target = exec(root);
  }

  run(argv: readonly string[], options: RunOptions): Promise<CommandResult> {
    return this.target.run(argv, options);
  }

  isClean(): Promise<boolean> {
    return isDirClean({ gitDir: this.quarantine.gitDir, indexFile: join(this.holder, "index") }, this.sha, this.root);
  }

  applyPatch(patch: string, options: { reverse: boolean }): Promise<boolean> {
    return applyPatchToDir(this.scratchGitDir, this.root, patch, options);
  }

  async dispose(): Promise<void> {
    this.abortSync();
  }

  abortSync(): void {
    rmSync(this.root, { recursive: true, force: true });
    rmSync(this.holder, { recursive: true, force: true });
  }
}

/** Test-only (M3e-D7): it has no production caller, and in M3f the copy lives inside the container. */
export class TempWorkCopyFactory implements WorkCopyFactory {
  constructor(private readonly options: TempWorkCopyOptions) {
    if (typeof options.exec !== "function") throw new Error("TempWorkCopyFactory needs an exec");
    if (!isAbsolute(options.parent)) throw new Error("TempWorkCopyFactory needs an absolute parent");
    assertOutsideAgentHomes(options.parent);
    mkdirSync(options.parent, { recursive: true, mode: 0o700 });
  }

  async create(spec: { quarantine: GitTarget; sha: string }): Promise<WorkCopy> {
    const id = `wc-${process.pid}-${randomBytes(4).toString("hex")}`;
    const root = join(this.options.parent, id);
    const holder = join(this.options.parent, `${id}-s`);
    mkdirSync(root, { mode: 0o700 });
    mkdirSync(holder, { mode: 0o700 });
    try {
      await exportTree(spec.quarantine, spec.sha, root);
      const scratchGitDir = await createScratchGitDir(holder);
      return new TempWorkCopy(id, root, holder, scratchGitDir, spec.quarantine, spec.sha, this.options.exec);
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      rmSync(holder, { recursive: true, force: true });
      throw error;
    }
  }
}

const COPY_NAME = /^wc-(\d+)-[0-9a-f]{8}(-s)?$/;

/** Removes `wc-<pid>-*` directories whose pid is dead (SIGKILL leaves one). Returns how many directories were removed. */
export async function sweepOrphanCopies(parent: string, alive: (pid: number) => boolean = isAlive): Promise<number> {
  if (!existsSync(parent)) return 0;
  let removed = 0;
  for (const name of readdirSync(parent)) {
    const match = COPY_NAME.exec(name);
    if (match === null || alive(Number(match[1]))) continue;
    rmSync(join(parent, name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
