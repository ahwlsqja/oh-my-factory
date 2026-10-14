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
describe("materialising and checking a tree", () => {
  it("exportTree writes tracked files only and keeps symlinks as symlinks", async () => {
    const dest = realTempDir("omf-export-");
    const result = await ops.exportTree(fx.quarantine, fx.head, dest);
    const tracked = await ops.treePaths(fx.quarantine, fx.head);
    expect(result.files).toBe(tracked.length);
    expect(listFiles(dest)).toEqual([...tracked].sort());
    expect(lstatSync(join(dest, "l.txt")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dest, "l.txt"))).toBe("src/a.ts");
    expect(existsSync(join(dest, ".git"))).toBe(false);
    expect(existsSync(join(fx.gitDir, "index"))).toBe(false); // the quarantine's own index is never created
  });

  it("exportTree refuses a destination it cannot trust and writes nothing through a symlink", async () => {
    const outside = realTempDir("omf-outside-");
    const planted = realTempDir("omf-planted-");
    symlinkSync(outside, join(planted, "src"));
    await expect(ops.exportTree(fx.quarantine, fx.head, planted)).rejects.toThrow("destination directory is not empty");
    const link = join(realTempDir("omf-link-"), "dest");
    symlinkSync(outside, link);
    await expect(ops.exportTree(fx.quarantine, fx.head, link)).rejects.toThrow("destination must be a real directory");
    await expect(ops.exportTree(fx.quarantine, fx.head, join(fx.gitDir, "export"))).rejects.toThrow("must live outside the repository");
    const home = realTempDir("omf-home-");
    mkdirSync(join(home, ".claude", "x"), { recursive: true });
    vi.stubEnv("HOME", home);
    await expect(ops.exportTree(fx.quarantine, fx.head, join(home, ".claude", "x"))).rejects.toThrow("must not live inside");
    expect(readdirSync(outside)).toEqual([]);
  });

  it("git itself refuses to check out through a planted symlink (the second layer under the empty-directory rule)", async () => {
    const outside = realTempDir("omf-outside-");
    const planted = realTempDir("omf-planted-");
    symlinkSync(outside, join(planted, "src"));
    const target: GitTarget = { gitDir: fx.gitDir, workTree: planted, indexFile: join(realTempDir("omf-index-"), "index") };
    await runHostGit(target, ["read-tree", fx.head]);
    expect(await codeOf(runHostGit(target, ["checkout-index", "-a"]))).toBe("git_failed");
    expect(readdirSync(outside)).toEqual([]);
  });

  it("isDirClean is true for a fresh export and false after any difference", async () => {
    const dir = realTempDir("omf-clean-");
    await ops.exportTree(fx.quarantine, fx.head, dir);
    // Regression: a fresh read-tree index has no stat data, so without `update-index --refresh` an identical tree reads as dirty.
    expect(await ops.isDirClean(withIndex(fx.quarantine), fx.head, dir)).toBe(true);
    expect(await ops.isDirClean(withIndex(fx.quarantine), fx.base, dir)).toBe(false);

    writeFileSync(join(dir, "src", "a.ts"), "export const a = 3;\n"); // same size as the committed line
    expect(await ops.isDirClean(withIndex(fx.quarantine), fx.head, dir)).toBe(false);
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
    expect(await ops.isDirClean(withIndex(fx.quarantine), fx.head, dir)).toBe(true);

    put(dir, "z.log", "x"); // matches the tree's own .gitignore, and still counts
    expect(await ops.isDirClean(withIndex(fx.quarantine), fx.head, dir)).toBe(false);
    rmSync(join(dir, "z.log"));
    writeFileSync(join(dir, ".git"), "gitdir: /nonexistent\n"); // a root .git is never part of a tree
    expect(await ops.isDirClean(withIndex(fx.quarantine), fx.head, dir)).toBe(false);
    expect(existsSync(join(fx.gitDir, "index"))).toBe(false);
  });

  it("isDirClean needs a private index of its own", async () => {
    const dir = realTempDir("omf-clean-");
    await expect(ops.isDirClean(fx.quarantine, fx.head, dir)).rejects.toThrow("private target.indexFile");
    await expect(ops.isDirClean({ ...fx.quarantine, indexFile: join(fx.gitDir, "index") }, fx.head, dir)).rejects.toThrow("own index");
  });

  it("a revert patch takes head back to base and forward again, byte for byte", async () => {
    const scratch = await createScratchGitDir(realTempDir("omf-scratch-"));
    const patch = await ops.revertPatch(fx.quarantine, fx.base, fx.head, CHANGED_PATHS);
    const dir = realTempDir("omf-head-");
    await ops.exportTree(fx.quarantine, fx.head, dir);
    expect(await ops.applyPatchToDir(scratch, dir, patch, { reverse: true })).toBe(true);
    expect(await ops.isDirClean(withIndex(fx.quarantine), fx.base, dir)).toBe(true);
    expect(await ops.applyPatchToDir(scratch, dir, patch, { reverse: false })).toBe(true);
    expect(await ops.isDirClean(withIndex(fx.quarantine), fx.head, dir)).toBe(true);
  });

  it("applyPatchToDir refuses .git paths and paths beyond a symlink", async () => {
    const scratch = await createScratchGitDir(realTempDir("omf-scratch-"));
    const dir = realTempDir("omf-apply-");
    const outside = realTempDir("omf-outside-");
    symlinkSync(outside, join(dir, "link"));
    const adding = (path: string): string =>
      ["diff --git a/PATH b/PATH", "new file mode 100644", "index 0000000..e69de29", "--- /dev/null", "+++ b/PATH", "@@ -0,0 +1 @@", "+pwn", ""]
        .join("\n")
        .replaceAll("PATH", path);
    for (const path of [".git/hooks/pre-commit", ".GIT/x", "link/pwn.txt"]) {
      expect(await ops.applyPatchToDir(scratch, dir, adding(path), { reverse: false }), path).toBe(false);
    }
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });

  it("archiveTar lists tracked files only and never overwrites", async () => {
    const out = join(realTempDir("omf-archive-"), "ctx.tar");
    await ops.archiveTar(fx.quarantine, fx.head, out);
    // `tar -t` only lists; nothing here ever extracts an archive.
    const names = execFileSync("tar", ["-tf", out], { encoding: "utf8" })
      .split("\n")
      .filter((name) => name !== "" && !name.endsWith("/"))
      .sort();
    expect(names).toEqual([...(await ops.treePaths(fx.quarantine, fx.head))].sort());
    expect(statSync(out).mode & 0o777).toBe(0o600);
    await expect(ops.archiveTar(fx.quarantine, fx.head, out)).rejects.toThrow("archive file already exists");
  });
});
describe("bundle import without a transport", () => {
  let bundles: BundleFixture;
  beforeAll(() => {
    bundles = makeBundles(fx);
  });

  it("imports a good bundle with verify, unbundle and fsck, and writes no ref", async () => {
    const quarantine = makeEmptyQuarantine();
    expect(await ops.bundleVerify(quarantine, bundles.good)).toBe(true);
    await ops.unbundle(quarantine, bundles.good);
    expect(await ops.fsckStrict(quarantine)).toBe(true);
    expect(await ops.resolveCommit(quarantine, fx.head)).toBe(fx.head);
    expect(gitIn(quarantine.gitDir, "for-each-ref")).toBe("");
  });

  it("rejects a junk file, a truncated pack and an object that fails fsck --strict", async () => {
    expect(await ops.bundleVerify(makeEmptyQuarantine(), bundles.junk)).toBe(false);
    expect(await codeOf(ops.unbundle(makeEmptyQuarantine(), bundles.truncated))).toBe("git_failed");
    // Git 2.53 imports the bad tree (`unbundle` does not run fsck by itself), and fsckStrict is what rejects it.
    const quarantine = makeEmptyQuarantine();
    expect(await ops.bundleVerify(quarantine, bundles.bad)).toBe(true);
    const failure = await codeOf(ops.unbundle(quarantine, bundles.bad));
    if (failure === undefined) expect(await ops.fsckStrict(quarantine)).toBe(false);
    else expect(failure).toBe("git_failed");
  });

  it("refuses a relative bundle path", async () => {
    await expect(ops.bundleVerify(makeEmptyQuarantine(), "good.bundle")).rejects.toThrow("bundle file must be an absolute path");
  });

  it("a plain fetch of a bundle fails under the hardened prefix, which is why import has no fetch path", async () => {
    const quarantine = makeEmptyQuarantine();
    expect(await codeOf(runHostGit(quarantine, ["fetch", bundles.good, "main"], { cwd: quarantine.gitDir }))).toBe("git_failed");
    let stderr = "";
    try {
      execFileSync("git", [...HARDENED_GIT_CONFIG, `--git-dir=${quarantine.gitDir}`, "fetch", bundles.good, "main"], {
        env: hardenedGitEnv(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      stderr = String((error as { stderr?: unknown }).stderr);
    }
    expect(stderr).toContain("transport 'file' not allowed");
  });
});
