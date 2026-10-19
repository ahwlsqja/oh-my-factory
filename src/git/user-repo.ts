import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { assertOutsideAgentHomes, assertOutsideRepo } from "../core/paths.js";
import { TarError, type TarEntry, tarOfEntries } from "../container/tar-dir.js";
import { type GitTarget, HostGitError, runHostGit } from "./hardened.js";
import { type TreeEntryInfo, bundleVerify, readBlobs, treeEntries, treeSha, unbundle } from "./ops.js";

/**
 * The user's own repository, reached only through the hardened host git (spec §5.4, §7). Everything here is read-only: it
 * lists and reads objects, never the work tree, the index, a hook or an attribute file, and it runs no filter. The codes are
 * closed and the message is the code, so no path of the user's tree reaches a log through an error.
 */
export type UserRepoErrorCode =
  | "git_dir_unsupported"
  | "repo_has_drivers"
  | "head_unborn"
  | "base_missing"
  | "base_not_commit"
  | "export_too_large"
  | "submodule_present"
  | "lfs_pointers"
  | "ref_checked_out"
  | "ref_not_ours"
  | "ref_update_failed";

export class UserRepoError extends Error {
  readonly code: UserRepoErrorCode;

  constructor(code: UserRepoErrorCode) {
    super(code);
    this.name = "UserRepoError";
    this.code = code;
  }
}

const SHA = /^[0-9a-f]{40}$/;

/**
 * `<repo>/.git` by real path. `.git` must be a real directory (not a file as in a linked worktree or submodule, not a symlink)
 * holding a regular `HEAD` and an `objects/` directory; a relative or missing path is refused too: `git_dir_unsupported`.
 */
export function userRepoTarget(repo: string): GitTarget {
  if (!isAbsolute(repo)) throw new UserRepoError("git_dir_unsupported");
  let real: string;
  try {
    real = realpathSync(repo);
  } catch {
    throw new UserRepoError("git_dir_unsupported");
  }
  const gitDir = join(real, ".git");
  const stat = (path: string): ReturnType<typeof lstatSync> | undefined => {
    try {
      return lstatSync(path, { throwIfNoEntry: false });
    } catch {
      // ENOTDIR (a `.git` file in front of `HEAD`) and the like: not the layout we accept.
      return undefined;
    }
  };
  const dir = stat(gitDir);
  const head = stat(join(gitDir, "HEAD"));
  const objects = stat(join(gitDir, "objects"));
  if (!dir?.isDirectory() || !head?.isFile() || !objects?.isDirectory()) throw new UserRepoError("git_dir_unsupported");
  return { gitDir };
}

/**
 * The hardened module reports a driver or an include in the repository's own config as `gitdir_invalid` before it starts git.
 * `userRepoTarget` has checked the structure, so here that code is the driver refusal; `output_limit` means the listing is too big.
 */
async function mapGitErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HostGitError) {
      if (error.code === "gitdir_invalid") throw new UserRepoError("repo_has_drivers");
      if (error.code === "output_limit") throw new UserRepoError("export_too_large");
    }
    throw error;
  }
}

/** A git call that exits non-zero is "no such thing" for the two probes below; any other failure propagates. */
async function probe(target: GitTarget, args: string[]): Promise<string | null> {
  try {
    return (await runHostGit(target, args, { cwd: target.gitDir })).stdout.toString("utf8").trim();
  } catch (error) {
    if (error instanceof HostGitError && error.code === "git_failed") return null;
    throw error;
  }
}

/**
 * The commit `HEAD` names (`rev-parse --verify HEAD^{commit}`). An unborn HEAD is `head_unborn`. The goal-side `headCommit` is not
 * used: it runs git in the repository's own directory. A longer object id (sha-256) is `git_dir_unsupported`.
 */
export async function userHeadCommit(repo: string): Promise<string> {
  const target = userRepoTarget(repo);
  return mapGitErrors(async () => {
    const sha = await probe(target, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    if (sha === null) throw new UserRepoError("head_unborn");
    if (!SHA.test(sha)) throw new UserRepoError("git_dir_unsupported");
    return sha;
  });
}

const LFS_FILTER = /(?:^|\s)filter=lfs(?:\s|$)/;

/** True when an attributes file has a non-comment line that sets `filter=lfs`: the files it covers are pointer files in the tree. */
function namesLfsFilter(text: string): boolean {
  return text.split(/\r?\n/).some((line) => !line.trimStart().startsWith("#") && LFS_FILTER.test(line));
}

function tarEntryOf(entry: TreeEntryInfo, bytes: Buffer): TarEntry {
  if (entry.mode === "120000") {
    const linkTarget = bytes.toString("utf8");
    return { path: entry.path, kind: "symlink", data: Buffer.alloc(0), linkTarget, executable: false };
  }
  const executable = (Number.parseInt(entry.mode, 8) & 0o111) !== 0;
  return { path: entry.path, kind: "file", data: bytes, linkTarget: "", executable };
}

/**
 * The host-built tarball of the tracked files of `baseSha`: `ls-tree -r -z`, one `cat-file --batch`, then `tarOfEntries` (fixed mtime,
 * mode 0644 or 0755, symlinks kept). Not `git archive`: no `export-ignore`, `export-subst`, `eol`, `ident`, `working-tree-encoding` or
 * filter applies, so every file is the committed blob, and the work tree is never read (ignored files, untracked files and uncommitted
 * edits cannot appear).
 *
 * Refusals, in order: `base_missing` (not a 40-hex sha, or no such object), `base_not_commit`, `repo_has_drivers`, `submodule_present`
 * (a gitlink: its content is not in the repository), `lfs_pointers` (a tracked `.gitattributes` at any depth sets `filter=lfs`, so the
 * container would receive pointer files; the hardened environment ignores global git config, so this check is what catches an LFS
 * repository), and `export_too_large` (the blobs or the finished tarball exceed `maxBytes`). A tracked path longer than ustar holds, or a
 * symlink target over 100 bytes, throws the `TarError` of `tar-dir.ts`. `tracked_paths` lets the station see whether the base already
 * tracks something under `.omf/<work-id>/`.
 */
export async function exportBase(input: {
  repo: string;
  baseSha: string;
  maxBytes: number;
}): Promise<{ tar: Buffer; base_tree_sha: string; tracked_paths: string[] }> {
  const { repo, baseSha, maxBytes } = input;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive integer");
  const target = userRepoTarget(repo);
  return mapGitErrors(async () => {
    if (!SHA.test(baseSha)) throw new UserRepoError("base_missing");
    const type = await probe(target, ["cat-file", "-t", baseSha]);
    if (type === null) throw new UserRepoError("base_missing");
    if (type !== "commit") throw new UserRepoError("base_not_commit");
    const tree = await treeSha(target, baseSha);
    if (tree === null) throw new UserRepoError("base_not_commit");

    const entries = await treeEntries(target, baseSha);
    if (entries.some((entry) => entry.type === "commit")) throw new UserRepoError("submodule_present");
    const blobs = await readBlobs(
      target,
      entries.map((entry) => entry.sha),
      maxBytes,
    );
    const bytesOf = (entry: TreeEntryInfo): Buffer => {
      const bytes = blobs.get(entry.sha);
      if (bytes === undefined) throw new Error("a tracked blob is missing from the batch read");
      return bytes;
    };
    for (const entry of entries) {
      if (entry.path.split("/").at(-1) === ".gitattributes" && namesLfsFilter(bytesOf(entry).toString("utf8"))) {
        throw new UserRepoError("lfs_pointers");
      }
    }

    let tar: Buffer;
    try {
      tar = tarOfEntries(entries.map((entry) => tarEntryOf(entry, bytesOf(entry))));
    } catch (error) {
      if (error instanceof TarError && error.code === "too_large") throw new UserRepoError("export_too_large");
      throw error;
    }
    if (tar.length > maxBytes) throw new UserRepoError("export_too_large");
    return { tar, base_tree_sha: tree, tracked_paths: entries.map((entry) => entry.path) };
  });
}

/** The full ref an item's candidate is published under. The name is not validated here: `publishBranch` asks git. */
export function branchRef(workId: string): string {
  return `refs/heads/omf/${workId}`;
}

const ZERO_SHA = "0".repeat(40);
const PUBLISH_REF = "refs/omf/publish";

/** What a failed git call means for a publish: a driver or include in the repository's own config, or any other refusal. */
function publishFailure(error: unknown): Error {
  if (error instanceof HostGitError) {
    return new UserRepoError(error.code === "gitdir_invalid" ? "repo_has_drivers" : "ref_update_failed");
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** `git check-ref-format` for the full ref, asked of the quarantine (it needs no repository, and the user's is not touched). */
async function refNameIsValid(quarantine: GitTarget, ref: string): Promise<boolean> {
  try {
    await runHostGit(quarantine, ["check-ref-format", ref]);
    return true;
  } catch (error) {
    if (error instanceof HostGitError && error.code === "git_failed") return false;
    throw error;
  }
}

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * True when the main work tree or any linked work tree has `ref` checked out. Moving a checked-out branch with `update-ref`
 * leaves that work tree's index and files behind its HEAD, which looks like uncommitted changes to the person using it.
 * Reads `.git/HEAD` and `.git/worktrees/<name>/HEAD` as text; no git process, nothing written.
 */
function isCheckedOut(gitDir: string, ref: string): boolean {
  const heads = [join(gitDir, "HEAD")];
  const linked = join(gitDir, "worktrees");
  try {
    for (const name of readdirSync(linked)) heads.push(join(linked, name, "HEAD"));
  } catch (error) {
    if (!missing(error)) throw error;
  }
  return heads.some((file) => {
    try {
      return readFileSync(file, "utf8").trim() === `ref: ${ref}`;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  });
}

/** The sha `ref` holds in the repository, or null when it does not exist (an exact name: a longer ref under it does not count). */
async function refValue(target: GitTarget, ref: string): Promise<string | null> {
  const { stdout } = await runHostGit(target, ["for-each-ref", "--format=%(objectname) %(refname)", ref]);
  for (const line of stdout.toString("utf8").split("\n")) {
    const [sha, name] = line.split(" ");
    if (name === ref && sha !== undefined) return sha;
  }
  return null;
}

/**
 * Publishes `head` as `refs/heads/omf/<work-id>` in the user's repository and touches nothing else there (spec §5.4, §7, §11
 * rule 1). The candidate is already in the quarantine, so no transport is used. Order:
 *
 * 1. the full ref name must be a valid one (asked of the quarantine);
 * 2. refuse `ref_checked_out` when the main or any linked work tree has the ref checked out;
 * 3. read the ref's current value and refuse `ref_not_ours` unless it is absent or one of `knownHeads` (the heads this item
 *    published, or recorded an intent to publish, so a crash between the update and its record does not strand the next
 *    round). Steps 1 to 3 run before any object is written to the user's repository;
 * 4. in the quarantine: `update-ref refs/omf/publish <head>` (a bundle needs a ref; a bare sha makes an empty bundle),
 *    `bundle create`, `bundle verify`, all inside a private directory under `scratchDir` that is removed afterwards;
 * 5. in the user's repository: `unbundle` (objects only, no ref), then `update-ref <ref> <head> <old>` with the reflog switched
 *    off for that call, so no file appears under `logs/`. The old value (all zeros when absent) makes the update a compare-and-swap:
 *    a branch that appeared or moved since step 3 fails the update and is left as the other writer made it.
 *
 * Hooks, fsmonitor and attribute programs are off for every call (`HARDENED_GIT_CONFIG`). No other ref, config, hook or index is
 * read or written. A repository whose own config defines a driver or an include is `repo_has_drivers`.
 */
export async function publishBranch(input: {
  repo: string;
  quarantine: GitTarget;
  workId: string;
  head: string;
  knownHeads: readonly string[];
  scratchDir: string;
}): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(input.head)) throw new Error("head must be a 40-hex commit sha");
  const ref = branchRef(input.workId);
  const user = userRepoTarget(input.repo);
  assertOutsideAgentHomes(input.scratchDir);
  assertOutsideRepo(input.scratchDir, input.repo);

  let old: string | null;
  try {
    if (!(await refNameIsValid(input.quarantine, ref))) throw new UserRepoError("ref_update_failed");
    if (isCheckedOut(user.gitDir, ref)) throw new UserRepoError("ref_checked_out");
    old = await refValue(user, ref);
  } catch (error) {
    throw publishFailure(error);
  }
  if (old !== null && !input.knownHeads.includes(old)) throw new UserRepoError("ref_not_ours");

  mkdirSync(input.scratchDir, { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(input.scratchDir, "publish-"));
  try {
    await runHostGit(input.quarantine, ["update-ref", PUBLISH_REF, input.head]);
    const bundleFile = join(work, "publish.bundle");
    await runHostGit(input.quarantine, ["bundle", "create", bundleFile, PUBLISH_REF]);
    if (!(await bundleVerify(input.quarantine, bundleFile))) throw new UserRepoError("ref_update_failed");
    await unbundle(user, bundleFile);
    await runHostGit(user, ["-c", "core.logAllRefUpdates=false", "update-ref", ref, input.head, old ?? ZERO_SHA]);
  } catch (error) {
    throw publishFailure(error);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
