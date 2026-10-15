import { execFileSync } from "node:child_process";
import { gitEnv } from "../../src/core/paths.js";
import { gitIn } from "./tmp.js";

export interface CommittedEntry {
  mode: "100644" | "100755" | "120000" | "160000";
  /** File bytes, or the target of a symlink. A gitlink has none. */
  bytes?: Buffer | string;
  /** The commit id a gitlink records. */
  sha?: string;
}

function plumb(repo: string, args: string[], input?: Buffer): string {
  const env = gitEnv();
  return execFileSync("git", args, { cwd: repo, input, encoding: "utf8", env, stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Adds one commit to a `makeGitRepo` repository whose blobs are exactly the given bytes. `hash-object --no-filters` plus
 * `update-index --cacheinfo` bypass every attribute, so CRLF under `text=auto` or a `$Id$` under `ident` land as written, and the work
 * tree is neither read nor changed. Returns the new commit's sha.
 */
export function commitBlobs(repo: string, entries: Record<string, CommittedEntry>, message = "fixture"): string {
  for (const [path, entry] of Object.entries(entries)) {
    const bytes = typeof entry.bytes === "string" ? Buffer.from(entry.bytes) : (entry.bytes ?? Buffer.alloc(0));
    const id =
      entry.mode === "160000"
        ? (entry.sha ?? "")
        : plumb(repo, ["hash-object", "-w", "--no-filters", "--stdin"], bytes);
    plumb(repo, ["update-index", "--add", "--cacheinfo", `${entry.mode},${id},${path}`]);
  }
  const identity = ["-c", "user.name=omf-test", "-c", "user.email=omf-test@example.invalid"];
  gitIn(repo, ...identity, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
  return gitIn(repo, "rev-parse", "HEAD").trim();
}

/** The committed bytes of `path` at `sha`, straight from `cat-file blob` (no filter). */
export function committedBytes(repo: string, sha: string, path: string): Buffer {
  return execFileSync("git", ["cat-file", "blob", `${sha}:${path}`], { cwd: repo, env: gitEnv() });
}

/** `git ls-tree -r --name-only`: the tracked paths of a commit (the fixtures use plain ASCII names). */
export function trackedNames(repo: string, sha: string): string[] {
  return gitIn(repo, "ls-tree", "-r", "--name-only", sha)
    .split("\n")
    .filter((line) => line !== "");
}
