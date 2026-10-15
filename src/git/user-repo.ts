import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { TarError, type TarEntry, tarOfEntries } from "../container/tar-dir.js";
import { type GitTarget, HostGitError, runHostGit } from "./hardened.js";
import { type TreeEntryInfo, readBlobs, treeEntries, treeSha } from "./ops.js";

/**
 * The user's own repository, reached only through the hardened host git (spec §5.4, §7; M3-D15). Everything here is read-only: it
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
