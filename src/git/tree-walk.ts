import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export type TreeEntryKind = "file" | "dir" | "symlink" | "other";
/** `path` is posix and relative to the root. */
export interface TreeEntry {
  path: string;
  kind: TreeEntryKind;
  size: number;
  executable: boolean;
}
export interface WalkLimits {
  maxEntries: number;
  maxDepth: number;
}
const DEFAULT_LIMITS: WalkLimits = { maxEntries: 200_000, maxDepth: 64 };
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;

export class TreeLimitError extends Error {}

/**
 * `lstat` only. A symlink is reported, never followed or descended into. `.git` is an ordinary entry here (callers decide).
 * `root` is an absolute directory OMF created. Sorted by path. Precondition: the container that wrote the tree is
 * stopped before any host read; a concurrent writer could still swap a directory between the check and a later open.
 */
export function walkTree(root: string, limits: Partial<WalkLimits> = {}): TreeEntry[] {
  const max = { ...DEFAULT_LIMITS, ...limits };
  const real = realpathSync(root);
  const entries: TreeEntry[] = [];
  const visit = (rel: string, depth: number): void => {
    for (const name of readdirSync(rel === "" ? real : join(real, rel))) {
      const path = rel === "" ? name : `${rel}/${name}`;
      const stat = lstatSync(join(real, path));
      if (entries.length >= max.maxEntries) throw new TreeLimitError("too many entries");
      const kind: TreeEntryKind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other";
      entries.push({ path, kind, size: kind === "file" ? stat.size : 0, executable: kind === "file" && (stat.mode & 0o111) !== 0 });
      if (kind === "dir") {
        if (depth + 1 >= max.maxDepth) throw new TreeLimitError("tree too deep");
        visit(path, depth + 1);
      }
    }
  };
  visit("", 0);
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export type TreeReadErrorCode = "outside_root" | "symlink_in_path" | "not_regular" | "too_large" | "missing";
/** The message is the code; the path is never in it. */
export class TreeReadError extends Error {
  readonly code: TreeReadErrorCode;
  constructor(code: TreeReadErrorCode) {
    super(code);
    this.name = "TreeReadError";
    this.code = code;
  }
}

/**
 * `lstat` of every path component, then `open` with `O_NOFOLLOW | O_NONBLOCK` and an `fstat` regular-file check. A FIFO swapped
 * in for a regular file cannot block the open (the `fstat` then refuses it). Default cap 8 MiB. The lstat-then-open guard covers
 * the leaf and the checked components only: a concurrent writer that swaps a directory component between the check and the
 * open is a recorded TOCTOU limit, not a claim of this function.
 */
export function readTreeFile(root: string, rel: string, maxBytes: number = DEFAULT_MAX_FILE_BYTES): Buffer {
  if (rel.includes("\0") || isAbsolute(rel)) throw new TreeReadError("outside_root");
  const segments = rel.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) throw new TreeReadError("outside_root");
  if (segments.length === 0) throw new TreeReadError("not_regular");
  let current = realpathSync(root);
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) throw new TreeReadError("missing");
    if (stat.isSymbolicLink()) throw new TreeReadError("symlink_in_path");
    const leaf = index === segments.length - 1;
    if (leaf ? !stat.isFile() : !stat.isDirectory()) throw new TreeReadError("not_regular");
  }
  let fd: number;
  try {
    fd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new TreeReadError("symlink_in_path");
    if (code === "ENOENT") throw new TreeReadError("missing");
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new TreeReadError("not_regular");
    if (stat.size > maxBytes) throw new TreeReadError("too_large");
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const read = readSync(fd, buffer, offset, stat.size - offset, null);
      if (read === 0) break;
      offset += read;
    }
    return buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}
