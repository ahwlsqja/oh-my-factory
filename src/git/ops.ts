import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { assertOutsideAgentHomes, assertOutsideRepo } from "../core/paths.js";
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

/**
 * Every commit message in `base..head`, each followed by a NUL, for the canary scan. The message bytes are read from the
 * raw commit objects with `cat-file --batch`: `git log --format=%B` re-encodes a message per the commit's own `encoding`
 * header, so a hostile commit could hide a canary from it.
 */
export async function commitMessages(target: GitTarget, base: string, head: string): Promise<string> {
  requireSha("base", base);
  requireSha("head", head);
  const listed = (await git(target, ["rev-list", `${base}..${head}`])).toString("utf8").split("\n").filter((line) => line.length > 0);
  if (listed.length === 0) return "";
  const raw = await git(target, ["cat-file", "--batch"], { input: `${listed.join("\n")}\n` });
  const parts: string[] = [];
  let offset = 0;
  while (offset < raw.length) {
    const eol = raw.indexOf(0x0a, offset);
    if (eol < 0) throw new Error("unexpected git cat-file output");
    const header = raw.subarray(offset, eol).toString("utf8").split(" ");
    const size = Number(header[2]);
    if (header[1] !== "commit" || !Number.isInteger(size) || size < 0) throw new Error("unexpected git cat-file output");
    const object = raw.subarray(eol + 1, eol + 1 + size);
    const blank = object.indexOf("\n\n");
    parts.push(`${blank < 0 ? "" : object.subarray(blank + 2).toString("utf8")}\0`);
    offset = eol + 1 + size + 1;
  }
  return parts.join("");
}

/** Every path in the tree of `sha` (files, symlinks and gitlinks), as git stores them. */
export async function treePaths(target: GitTarget, sha: string): Promise<string[]> {
  requireSha("sha", sha);
  const out = await git(target, ["ls-tree", "-r", "-z", "--name-only", "--full-tree", sha]);
  return decodeUtf8Strict(out).split("\0").filter((path) => path.length > 0);
}

function requireAbsolute(label: string, path: string): void {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Guards a path OMF is about to write: absolute, not inside the quarantine it was read from, not inside an agent's
 * config home (spec §11 rule 1). The user's own repository is checked where the project location is derived
 * (`locateProject`); this module never learns it.
 */
function assertHostOutput(path: string, target: GitTarget): void {
  requireAbsolute("output path", path);
  assertOutsideRepo(path, target.gitDir);
  assertOutsideAgentHomes(path);
}

/** `checkout-index` skips files that already exist, which would export a stale tree, so the destination must be empty and real. */
function requireEmptyDirectory(dir: string): void {
  const stat = lstatOrNull(dir);
  if (stat === null) throw new Error("destination directory does not exist");
  if (!stat.isDirectory()) throw new Error("destination must be a real directory, not a symlink");
  if (readdirSync(dir).length > 0) throw new Error("destination directory is not empty");
}

/** A 0700 temp directory that holds one index file for the duration of `fn`, so the quarantine's own index is never written. */
async function withPrivateIndex<T>(fn: (indexFile: string) => Promise<T>): Promise<T> {
  assertOutsideAgentHomes(tmpdir()); // the private index is a host write too
  const dir = mkdtempSync(join(tmpdir(), "omf-index-"));
  try {
    return await fn(join(dir, "index"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Writes the tracked files of `sha` into the empty directory `destDir`: `read-tree` into a private index, then
 * `checkout-index -a` with `destDir` as the work tree. Git itself refuses to write through a symlink or into `.git`
 * (the empty-directory rule means a planted symlink never gets that far). Symlinks in the tree stay symlinks. The
 * quarantine may be bare, which is why this uses `--work-tree` and not `--prefix`.
 */
export async function exportTree(target: GitTarget, sha: string, destDir: string): Promise<{ files: number }> {
  requireSha("sha", sha);
  assertHostOutput(destDir, target);
  requireEmptyDirectory(destDir);
  return withPrivateIndex(async (indexFile) => {
    const scoped: GitTarget = { gitDir: target.gitDir, workTree: destDir, indexFile };
    await git(scoped, ["read-tree", sha]);
    const listing = await git(scoped, ["ls-files", "-z"]);
    await git(scoped, ["checkout-index", "-a"]);
    return { files: listing.toString("utf8").split("\0").filter((path) => path.length > 0).length };
  });
}

/**
 * `git archive --format=tar` of `sha` into a new file (0600, created exclusively so a planted symlink or an existing
 * file is refused). For a Docker build context (M3f); an archive from a hostile source is never extracted on the host.
 */
export async function archiveTar(target: GitTarget, sha: string, outFile: string): Promise<void> {
  requireSha("sha", sha);
  assertHostOutput(outFile, target);
  mkdirSync(dirname(outFile), { recursive: true, mode: 0o700 });
  try {
    closeSync(openSync(outFile, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("archive file already exists");
    throw error;
  }
  try {
    await git(target, ["archive", "--format=tar", "-o", outFile, sha]);
  } catch (error) {
    rmSync(outFile, { force: true });
    throw error;
  }
}

/**
 * `git apply [-R] --whitespace=nowarn` in `dir`, against a scratch git directory that has no config of its own.
 * Git refuses a path inside `.git` (any case) and a path beyond a symlink, so a hostile patch or tree cannot make
 * it write outside `dir`. False when git refuses or the patch does not apply (nothing is changed: apply is atomic);
 * an empty patch is refused too. A timeout or a bad git directory throws.
 */
export async function applyPatchToDir(scratchGitDir: string, dir: string, patch: string, options: { reverse: boolean }): Promise<boolean> {
  requireAbsolute("directory", dir);
  const args = ["apply", ...(options.reverse ? ["-R"] : []), "--whitespace=nowarn"];
  try {
    await runHostGit({ gitDir: scratchGitDir, workTree: dir }, args, { input: Buffer.from(patch, "latin1"), cwd: dir });
    return true;
  } catch (error) {
    if (exitedWith(error) !== null) return false;
    throw error;
  }
}

/**
 * True only when `dir` equals the tree of `sha`. `target.indexFile` is required and must be private: a temp file
 * this call overwrites, never the repository's own index. All with `workTree: dir`:
 * 1. `read-tree sha`;
 * 2. `update-index -q --refresh`: a fresh read-tree index has no stat data and plumbing `diff-files` never refreshes,
 *    so without this step an identical tree reads as dirty;
 * 3. `diff-files --quiet` (exit 1 is dirty);
 * 4. `ls-files -o --directory` must print nothing. No ignore rule applies (`core.excludesFile=/dev/null`, and
 *    `--exclude-standard` is not passed), so a file the tree's own `.gitignore` names still counts.
 * A `.git` entry anywhere under `dir` is checked last (lstat walk, no symlink follow): git skips entries named `.git`,
 * so `ls-files -o` never lists one, and none is ever part of a tree.
 */
export async function isDirClean(target: GitTarget, sha: string, dir: string): Promise<boolean> {
  requireSha("sha", sha);
  requireAbsolute("directory", dir);
  if (target.indexFile === undefined) throw new Error("isDirClean needs a private target.indexFile");
  if (resolve(target.indexFile) === resolve(target.gitDir, "index")) throw new Error("indexFile must not be the repository's own index");
  const scoped: GitTarget = { gitDir: target.gitDir, workTree: dir, indexFile: target.indexFile };
  await git(scoped, ["read-tree", sha]);
  try {
    await git(scoped, ["update-index", "-q", "--refresh"]);
    await git(scoped, ["diff-files", "--quiet"]);
  } catch (error) {
    if (exitedWith(error) === 1) return false;
    throw error;
  }
  const untracked = await git(scoped, ["ls-files", "-o", "--directory"]);
  return untracked.length === 0 && !containsDotGit(dir);
}

/** True when any entry under `dir` (or `dir` itself, at the root) is named `.git`. Symlinks are never followed. */
function containsDotGit(dir: string): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") return true;
    if (entry.isDirectory() && containsDotGit(join(dir, entry.name))) return true;
  }
  return false;
}

const SMALL_OUTPUT_BYTES = 1024 * 1024;

/**
 * Transport-free bundle import, in three calls the caller must make in order: `bundleVerify`, `unbundle`,
 * `fsckStrict`. `HARDENED_GIT_CONFIG` keeps `protocol.file.allow=never`, so `git fetch x.bundle` fails by design;
 * `unbundle` writes objects and no refs and uses no transport. The bundle file is OMF-created, its contents are hostile.
 * False when git rejects the header or the output is unreasonably large. A header-only check: a bundle with an intact
 * header and a truncated pack still verifies, and `unbundle` is what fails on it. Ref names are never returned.
 */
export async function bundleVerify(target: GitTarget, bundleFile: string): Promise<boolean> {
  requireAbsolute("bundle file", bundleFile);
  try {
    await git(target, ["bundle", "verify", bundleFile], { maxOutputBytes: SMALL_OUTPUT_BYTES });
    return true;
  } catch (error) {
    if (error instanceof HostGitError && (error.code === "git_failed" || error.code === "output_limit")) return false;
    throw error;
  }
}

/**
 * Writes the objects of the bundle into the quarantine repository and no ref. Git does not run `fsck` here, so the
 * objects of a rejected import may be in the repository: run `fsckStrict`, and discard the quarantine on false.
 */
export async function unbundle(target: GitTarget, bundleFile: string): Promise<void> {
  requireAbsolute("bundle file", bundleFile);
  assertOutsideAgentHomes(target.gitDir);
  await git(target, ["bundle", "unbundle", bundleFile], { maxOutputBytes: SMALL_OUTPUT_BYTES });
}

/** `git fsck --strict --no-dangling --no-progress`; true only on exit 0. Run after every `unbundle`, before any object is trusted. */
export async function fsckStrict(target: GitTarget): Promise<boolean> {
  try {
    await git(target, ["fsck", "--strict", "--no-dangling", "--no-progress"], { maxOutputBytes: SMALL_OUTPUT_BYTES });
    return true;
  } catch (error) {
    if (error instanceof HostGitError && (error.code === "git_failed" || error.code === "output_limit")) return false;
    throw error;
  }
}
