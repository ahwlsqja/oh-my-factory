import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { gitEnv } from "../../src/core/paths.js";
import type { GitTarget } from "../../src/git/hardened.js";
import { commitAll, gitIn, makeTempDir } from "./tmp.js";

/** Writes `content` at `root/rel` and creates the directories above it. */
export function put(root: string, rel: string, content: string | Buffer): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A fresh temp directory by real path: the macOS temp dir is a symlink, and `assertOutsideRepo` and git's printed paths compare real paths. */
export function realTempDir(prefix: string): string {
  return realpathSync(makeTempDir(prefix));
}

/** Every non-directory under `root` (symlinks included, never followed), posix paths, sorted. */
export function listFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

/** The paths that differ between `base` and `head` of `makeOpsFixture`, in byte order. A rename shows as src/keep.ts (D) plus src/moved.ts (A). */
export const CHANGED_PATHS: readonly string[] = [
  "*", "bin.dat", "docs/old.md", "l.txt", "latin1.txt", "run.sh", "src/a.ts", "src/keep.ts", "src/moved.ts", "src/new.ts",
];

export interface OpsFixture {
  work: string;
  gitDir: string;
  quarantine: GitTarget;
  base: string;
  head: string;
}

/**
 * A work repository with a base and a head commit that exercise every raw-diff status: a modified text file, a
 * modified binary, a deleted file, a rename, an added file, a file literally named `*`, a non-UTF-8 text file, a
 * file turned into a symlink (T) and a mode-only change. The quarantine is a bare clone of it, the shape M3g builds.
 */
export function makeOpsFixture(): OpsFixture {
  const work = realTempDir("omf-ops-work-");
  gitIn(work, "init", "-q", "-b", "main");
  put(work, "src/a.ts", "export const a = 1;\n");
  put(work, "src/keep.ts", "export const keep = true;\n");
  put(work, "tests/a.test.ts", "// a test\n");
  put(work, "docs/old.md", "old\n");
  put(work, "*", "star\n");
  put(work, "bin.dat", Buffer.from(Array.from({ length: 200 }, (_, i) => (i * 7) % 256)));
  put(work, "latin1.txt", Buffer.from("café 1\n", "latin1"));
  put(work, "l.txt", "plain\n");
  put(work, "run.sh", "#!/bin/sh\n");
  put(work, ".gitignore", "*.log\n");
  commitAll(work, "base");
  const base = gitIn(work, "rev-parse", "HEAD").trim();

  put(work, "src/a.ts", "export const a = 2;\n");
  put(work, "bin.dat", Buffer.from(Array.from({ length: 250 }, (_, i) => (i * 11) % 256)));
  rmSync(join(work, "docs", "old.md"));
  rmSync(join(work, "src", "keep.ts"));
  put(work, "src/moved.ts", "export const keep = true;\n");
  put(work, "src/new.ts", "export const n = 1;\n");
  put(work, "*", "star2\n");
  put(work, "latin1.txt", Buffer.from("café 2\n", "latin1"));
  rmSync(join(work, "l.txt"));
  symlinkSync("src/a.ts", join(work, "l.txt"));
  chmodSync(join(work, "run.sh"), 0o755);
  commitAll(work, "head: edit src");
  const head = gitIn(work, "rev-parse", "HEAD").trim();

  const gitDir = join(realTempDir("omf-ops-quarantine-"), "q.git");
  gitIn(work, "clone", "-q", "--bare", work, gitDir);
  return { work, gitDir, quarantine: { gitDir }, base, head };
}

/** An empty bare repository: where a bundle is imported. */
export function makeEmptyQuarantine(): GitTarget {
  const gitDir = join(realTempDir("omf-ops-empty-"), "q.git");
  gitIn(dirname(gitDir), "init", "-q", "--bare", gitDir);
  return { gitDir };
}

export interface BundleFixture {
  good: string;
  /** Header intact, last 30 bytes of the pack cut: `bundle verify` passes, `unbundle` fails. */
  truncated: string;
  junk: string;
  /** A commit whose tree has a `.git` entry: `unbundle` imports it, `fsck --strict` rejects it. */
  bad: string;
}

function plumb(repo: string, args: string[], input?: Buffer): string {
  return execFileSync("git", args, { cwd: repo, input, encoding: "utf8", env: gitEnv(), stdio: ["pipe", "pipe", "pipe"] }).trim();
}

export function makeBundles(fixture: OpsFixture): BundleFixture {
  const dir = realTempDir("omf-ops-bundles-");
  const good = join(dir, "good.bundle");
  gitIn(fixture.work, "bundle", "create", good, "main");
  const bytes = readFileSync(good);
  const truncated = join(dir, "truncated.bundle");
  writeFileSync(truncated, bytes.subarray(0, bytes.length - 30));
  const junk = join(dir, "junk.bundle");
  writeFileSync(junk, "not a bundle\n");

  const evil = realTempDir("omf-ops-bad-");
  plumb(evil, ["init", "-q"]);
  const blob = plumb(evil, ["hash-object", "-w", "--stdin"], Buffer.from("x\n"));
  const tree = plumb(
    evil,
    ["hash-object", "-t", "tree", "-w", "--stdin", "--literally"],
    Buffer.concat([Buffer.from("100644 .git\0"), Buffer.from(blob, "hex")]),
  );
  const commit = plumb(evil, ["-c", "user.name=omf-test", "-c", "user.email=omf-test@example.invalid", "commit-tree", tree, "-m", "bad"]);
  plumb(evil, ["update-ref", "refs/heads/bad", commit]);
  const bad = join(dir, "bad.bundle");
  plumb(evil, ["bundle", "create", bad, "bad"]);
  return { good, truncated, junk, bad };
}
