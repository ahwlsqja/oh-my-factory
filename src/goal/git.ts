import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import picomatch from "picomatch";
import { canonicalize, sha256Hex } from "../core/canonical-json.js";
import { gitEnv } from "../core/paths.js";

/**
 * Runs git against a throwaway copy of the index. Even read commands such as `git diff` refresh the index
 * and take `.git/index.lock`, which would collide with the user's own git commands, so the real index is
 * only ever read.
 */
function git(repo: string, args: string[]): string {
  const scratch = mkdtempSync(join(tmpdir(), "omf-git-"));
  try {
    const realIndex = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "index"], {
      cwd: repo,
      encoding: "utf8",
      env: gitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const index = join(scratch, "index");
    if (existsSync(realIndex)) copyFileSync(realIndex, index);
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: { ...gitEnv(), GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    const detail = typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim() : (err as Error).message;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function nulSeparated(text: string): string[] {
  return text.split("\0").filter((path) => path.length > 0);
}

export function headCommit(repo: string): string {
  return git(repo, ["rev-parse", "HEAD"]).trim();
}

/**
 * Tracked files only (`git ls-files`), sorted. Untracked and ignored files are not listed: the risk class
 * expands a declared directory through this list, and a file git does not track is not part of the project (spec §4.4).
 */
export function trackedFiles(repo: string): string[] {
  return nulSeparated(git(repo, ["ls-files", "-z"])).sort();
}

/**
 * Commits on the first-parent line from `commit` (exclusive) to HEAD, so a merged branch counts once, as the
 * merge commit. Throws like the other helpers when `commit` is no longer in the repository.
 */
export function commitsSince(repo: string, commit: string): number {
  return Number.parseInt(git(repo, ["rev-list", "--count", "--first-parent", `${commit}..HEAD`]).trim(), 10);
}

/**
 * Paths that differ from `commit`: committed and uncommitted edits, deletions, and untracked files that
 * are not ignored. Renames count as a deletion plus an addition, so both paths are reported.
 */
export function changedPathsSince(repo: string, commit: string): string[] {
  const tracked = nulSeparated(git(repo, ["diff", "--name-only", "--no-renames", "-z", commit, "--"]));
  const untracked = nulSeparated(git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]));
  return [...new Set([...tracked, ...untracked])].sort();
}

/** `git diff --stat` of the paths against `commit`, for showing a person what changed. Empty when nothing differs. */
export function diffStat(repo: string, commit: string, paths: readonly string[]): string {
  if (paths.length === 0) return "";
  return git(repo, ["diff", "--stat", "--no-renames", commit, "--", ...paths]).trimEnd();
}

/** Identifies what a measurement ran against: the commit plus any uncommitted state. */
export function workingTreeFingerprint(repo: string): string {
  const status = git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return sha256Hex(canonicalize({ head: headCommit(repo), status }));
}

/** The paths that match any glob. Dot files match, so `.github/**` covers workflows. */
export function matchWatched(paths: readonly string[], globs: readonly string[]): string[] {
  if (globs.length === 0) return [];
  const isMatch = picomatch([...globs], { dot: true });
  return paths.filter((path) => isMatch(path));
}
