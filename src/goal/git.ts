import { execFileSync } from "node:child_process";
import picomatch from "picomatch";
import { canonicalize, sha256Hex } from "../core/canonical-json.js";
import { gitEnv } from "../core/paths.js";

function git(repo: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    const detail = typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim() : (err as Error).message;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
}

function nulSeparated(text: string): string[] {
  return text.split("\0").filter((path) => path.length > 0);
}

export function headCommit(repo: string): string {
  return git(repo, ["rev-parse", "HEAD"]).trim();
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
