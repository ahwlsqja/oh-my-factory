import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { gitEnv } from "../../src/core/paths.js";
import { HARDENED_GIT_CONFIG, HostGitError, createScratchGitDir, hardenedGitEnv, runHostGit, type GitTarget } from "../../src/git/hardened.js";
import * as ops from "../../src/git/ops.js";
import {
  CHANGED_PATHS, listFiles, makeBundles, makeEmptyQuarantine, makeOpsFixture, put, realTempDir,
  type BundleFixture, type OpsFixture,
} from "../helpers/ops-fixture.js";
import { gitIn } from "../helpers/tmp.js";

let fx: OpsFixture;
beforeAll(() => {
  fx = makeOpsFixture();
});
afterEach(() => vi.unstubAllEnvs());

/** The HostGitError code of a failed call, "not a HostGitError" for anything else, undefined when it succeeded. */
async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    return err instanceof HostGitError ? err.code : "not a HostGitError";
  }
  return undefined;
}

/** A target with a private temp index, as `isDirClean` requires. */
const withIndex = (target: GitTarget): GitTarget => ({ ...target, indexFile: join(realTempDir("omf-index-"), "index") });

describe("read-only operations", () => {
  it("resolveCommit takes a 40-hex sha and nothing else", async () => {
    expect(await ops.resolveCommit(fx.quarantine, fx.head)).toBe(fx.head);
    expect(await ops.resolveCommit(fx.quarantine, "main")).toBeNull();
    expect(await ops.resolveCommit(fx.quarantine, "0".repeat(40))).toBeNull();
    const tree = gitIn(fx.work, "rev-parse", "HEAD^{tree}").trim();
    expect(await ops.resolveCommit(fx.quarantine, tree)).toBeNull();
  });

  it("rawDiff and treePaths fail closed on a path that is not valid UTF-8, with a message that names no path", async () => {
    const repo = realTempDir("omf-badpath-");
    const run = (args: string[], input?: Buffer): string =>
      execFileSync("git", args, { cwd: repo, input, encoding: "utf8", env: gitEnv(), stdio: ["pipe", "pipe", "pipe"] }).trim();
    run(["init", "-q", "-b", "main"]);
    const blob = run(["hash-object", "-w", "--stdin"], Buffer.from("x\n"));
    const empty = run(["hash-object", "-t", "tree", "-w", "--stdin", "--literally"], Buffer.alloc(0));
    const entry = Buffer.concat([Buffer.from("100644 "), Buffer.from([0xff, 0x61]), Buffer.from([0]), Buffer.from(blob, "hex")]);
    const tree = run(["hash-object", "-t", "tree", "-w", "--stdin", "--literally"], entry);
    const commit = (treeSha: string, parent?: string): string =>
      run(["-c", "user.name=omf-test", "-c", "user.email=omf-test@example.invalid", "commit-tree", treeSha, ...(parent === undefined ? [] : ["-p", parent]), "-m", "c"]);
    const base = commit(empty);
    const head = commit(tree, base);
    const target: GitTarget = { gitDir: join(repo, ".git") };
    await expect(ops.rawDiff(target, base, head)).rejects.toThrow("not valid UTF-8");
    await expect(ops.treePaths(target, head)).rejects.toThrow("not valid UTF-8");
  });

  it("isAncestor answers for shas and refuses names", async () => {
    expect(await ops.isAncestor(fx.quarantine, fx.base, fx.head)).toBe(true);
    expect(await ops.isAncestor(fx.quarantine, fx.head, fx.base)).toBe(false);
    await expect(ops.isAncestor(fx.quarantine, "main", fx.head)).rejects.toThrow("ancestor must be a 40-hex commit sha");
  });

  it("rawDiff marks A, M, D and T with modes, and reports a rename as D plus A", async () => {
    const entries = await ops.rawDiff(fx.quarantine, fx.base, fx.head);
    expect(entries.map((entry) => entry.path).sort()).toEqual([...CHANGED_PATHS].sort());
    const by = new Map(entries.map((entry) => [entry.path, entry]));
    expect(by.get("src/a.ts")).toEqual({ status: "M", path: "src/a.ts", old_mode: "100644", new_mode: "100644" });
    expect(by.get("run.sh")).toMatchObject({ status: "M", old_mode: "100644", new_mode: "100755" });
    expect(by.get("l.txt")).toMatchObject({ status: "T", old_mode: "100644", new_mode: "120000" });
    expect(by.get("src/moved.ts")).toMatchObject({ status: "A", old_mode: "000000", new_mode: "100644" });
    expect(by.get("src/keep.ts")).toMatchObject({ status: "D", old_mode: "100644", new_mode: "000000" });
    expect(by.get("docs/old.md")?.status).toBe("D");
  });

  it("revertPatch treats every path literally and never diffs everything for an empty list", async () => {
    const patch = await ops.revertPatch(fx.quarantine, fx.base, fx.head, ["*"]);
    expect(patch).toContain("diff --git a/* b/*");
    expect(patch).not.toContain("src/a.ts");
    expect(patch).not.toContain("bin.dat");
    // An empty list returns before git runs: this target does not exist, so a git call would throw.
    expect(await ops.revertPatch({ gitDir: "/nonexistent" }, fx.base, fx.head, [])).toBe("");
  });

  it("revertPatch cuts long path lists into chunks and concatenates the patches", async () => {
    const whole = await ops.revertPatch(fx.quarantine, fx.base, fx.head, CHANGED_PATHS);
    expect(whole).toContain("diff --git a/src/moved.ts");
    expect(await ops.revertPatch(fx.quarantine, fx.base, fx.head, CHANGED_PATHS, { chunkPaths: 3 })).toBe(whole);
    expect(await ops.revertPatch(fx.quarantine, fx.base, fx.head, CHANGED_PATHS, { chunkBytes: 1 })).toBe(whole);
    // 15,000 pathspecs of 93 bytes are about 1.4 MB of argv, over the 1 MiB ARG_MAX of macOS: one call could not even start.
    const ghosts = Array.from({ length: 15_000 }, (_, i) => `ghost/${String(i).padStart(5, "0")}/${"x".repeat(80)}`);
    const big = await ops.revertPatch(fx.quarantine, fx.base, fx.head, [...ghosts, "src/a.ts", "bin.dat"]);
    expect(big).toBe(await ops.revertPatch(fx.quarantine, fx.base, fx.head, ["bin.dat", "src/a.ts"]));
  });

  it("unifiedDiff, commitMessages and treePaths read the commits", async () => {
    const diff = await ops.unifiedDiff(fx.quarantine, fx.base, fx.head);
    expect(diff.toString("latin1")).toContain("+export const a = 2;");
    const messages = await ops.commitMessages(fx.quarantine, fx.base, fx.head);
    expect(messages).toContain("head: edit src\n\0");
    expect(messages).not.toContain("base");
    expect(await ops.treePaths(fx.quarantine, fx.base)).toContain("docs/old.md");
    expect(await ops.treePaths(fx.quarantine, fx.head)).not.toContain("docs/old.md");
  });
});
