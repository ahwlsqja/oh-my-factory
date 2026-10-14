import { HostGitError, runHostGit, type GitTarget, type HostGitOptions } from "./hardened.js";

/**
 * Git operations on a quarantine repository, all through `runHostGit` (spec §5.4, §7; M3-D15).
 *
 * Revisions are 40-hex shas only: a branch or tag name resolves through refs, and an argument that starts with `-`
 * could be read as an option. The repository is always named with `--git-dir`; a tree a container wrote is only ever
 * a `--work-tree` or a plain directory, so its `.git`, config, hooks and symlinks are never consulted. The results
 * carry no stderr: git's messages name tree paths, and `HostGitError` drops them.
 */

/** One line of `git diff --raw`: what happened to one path between two commits. */
export interface RawDiffEntry {
  status: "A" | "M" | "D" | "T";
  path: string;
  old_mode: string;
  new_mode: string;
}

const SHA = /^[0-9a-f]{40}$/;
const DEFAULT_CHUNK_PATHS = 200;
const DEFAULT_CHUNK_BYTES = 64 * 1024;

function requireSha(label: string, value: string): void {
  if (!SHA.test(value)) throw new Error(`${label} must be a 40-hex commit sha`);
}

/** Runs git with the working directory set away from the user's repository: the work tree when there is one, else the git dir. */
function git(target: GitTarget, args: readonly string[], options: HostGitOptions = {}): Promise<Buffer> {
  return runHostGit(target, args, { cwd: target.workTree ?? target.gitDir, ...options }).then((result) => result.stdout);
}

/** The exit status of a git that ran and exited non-zero; null for any other failure (timeout, output limit, bad git dir), which callers rethrow. */
function exitedWith(error: unknown): number | null {
  return error instanceof HostGitError && error.code === "git_failed" ? error.exitStatus : null;
}

/** The full sha when `sha` names a commit in the repository, else null. A ref name is never looked up, so it is null too. */
export async function resolveCommit(target: GitTarget, sha: string): Promise<string | null> {
  if (!SHA.test(sha)) return null;
  try {
    const out = await git(target, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
    return out.toString("utf8").trim();
  } catch (error) {
    if (exitedWith(error) !== null) return null;
    throw error;
  }
}

export async function isAncestor(target: GitTarget, ancestor: string, descendant: string): Promise<boolean> {
  requireSha("ancestor", ancestor);
  requireSha("descendant", descendant);
  try {
    await git(target, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    if (exitedWith(error) === 1) return false;
    throw error;
  }
}

/** Strict UTF-8: a path that is not valid UTF-8 throws instead of turning into replacement characters. The message names no path. */
function decodeUtf8Strict(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("a path in the git output is not valid UTF-8");
  }
}

function isRawStatus(value: string): value is RawDiffEntry["status"] {
  return value === "A" || value === "M" || value === "D" || value === "T";
}

/**
 * `git diff --raw -z --no-renames`: a rename is a deletion plus an addition, so renaming a test file is visible as
 * the edit it is. No external diff driver and no textconv runs. Paths are decoded as strict UTF-8: a path that is not valid UTF-8 would be mangled
 * here and match nothing when it is later passed back to git as a literal pathspec (`revertPatch`), so the function fails closed instead.
 */
export async function rawDiff(target: GitTarget, base: string, head: string): Promise<RawDiffEntry[]> {
  requireSha("base", base);
  requireSha("head", head);
  const out = await git(target, ["diff", "--raw", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", base, head]);
  const fields = decodeUtf8Strict(out).split("\0");
  if (fields.at(-1) === "") fields.pop();
  const entries: RawDiffEntry[] = [];
  for (let i = 0; i < fields.length; i += 2) {
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])$/.exec(fields[i] ?? "");
    const path = fields[i + 1];
    if (match === null || path === undefined) throw new Error("unexpected `git diff --raw` output");
    const [, oldMode = "", newMode = "", status = ""] = match;
    if (!isRawStatus(status)) throw new Error("unexpected `git diff --raw` status");
    entries.push({ status, path, old_mode: oldMode, new_mode: newMode });
  }
  return entries;
}

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function* chunked(paths: readonly string[], maxPaths: number, maxBytes: number): Generator<string[]> {
  let chunk: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const size = Buffer.byteLength(path) + 1;
    if (chunk.length > 0 && (chunk.length >= maxPaths || bytes + size > maxBytes)) {
      yield chunk;
      chunk = [];
      bytes = 0;
    }
    chunk.push(path);
    bytes += size;
  }
  if (chunk.length > 0) yield chunk;
}

/**
 * A patch that, applied with `reverse: true`, takes `head`'s content of `paths` back to `base`'s.
 *
 * `--literal-pathspecs` is a global option and goes before `diff`: a candidate can name a file `*`, and without it
 * that name would match every file. `git diff` has no `--pathspec-from-file`, so a long list is cut into chunks
 * (200 paths and 64 KiB of argv by default) and the per-chunk patches are concatenated; patches over disjoint
 * paths concatenate safely. An empty list returns "" without running git, because `diff` with no pathspec diffs
 * everything. The result is a byte string (`latin1`, one char per byte), so non-UTF-8 hunks survive the trip
 * through `applyPatchToDir`; do not treat it as text.
 */
export async function revertPatch(
  target: GitTarget,
  base: string,
  head: string,
  paths: readonly string[],
  options: { chunkPaths?: number; chunkBytes?: number } = {},
): Promise<string> {
  requireSha("base", base);
  requireSha("head", head);
  const chunkPaths = options.chunkPaths ?? DEFAULT_CHUNK_PATHS;
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  if (!Number.isInteger(chunkPaths) || chunkPaths < 1 || !Number.isInteger(chunkBytes) || chunkBytes < 1) {
    throw new Error("chunk sizes must be positive integers");
  }
  const sorted = [...new Set(paths)].sort(compareBytes);
  const patches: string[] = [];
  for (const chunk of chunked(sorted, chunkPaths, chunkBytes)) {
    const out = await git(target, [
      "--literal-pathspecs", "diff", "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv",
      base, head, "--", ...chunk,
    ]);
    patches.push(out.toString("latin1"));
  }
  return patches.join("");
}

/**
 * The whole diff as bytes, for the canary scan. Over `maxOutputBytes` (64 MiB) it throws `output_limit`, which the
 * caller must treat as an incomplete surface, never as a clean one.
 */
export async function unifiedDiff(target: GitTarget, base: string, head: string): Promise<Buffer> {
  requireSha("base", base);
  requireSha("head", head);
  return git(target, ["diff", "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv", base, head]);
}

/** Every commit message in `base..head`, each followed by a NUL, for the canary scan. */
export async function commitMessages(target: GitTarget, base: string, head: string): Promise<string> {
  requireSha("base", base);
  requireSha("head", head);
  const out = await git(target, ["log", "--format=%B%x00", `${base}..${head}`]);
  return out.toString("utf8");
}

/** Every path in the tree of `sha` (files, symlinks and gitlinks), as git stores them. */
export async function treePaths(target: GitTarget, sha: string): Promise<string[]> {
  requireSha("sha", sha);
  const out = await git(target, ["ls-tree", "-r", "-z", "--name-only", "--full-tree", sha]);
  return decodeUtf8Strict(out).split("\0").filter((path) => path.length > 0);
}
