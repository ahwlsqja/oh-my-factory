import {
  type Stats,
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type ProjectLocation, omfHome } from "./paths.js";

/**
 * Host-state symlink hardening (spec §8, design M3c-D15). OMF state lives in a directory a person owns, but
 * a link planted below it redirects every later write (a lock, a vault file, `preflight.json`) to
 * somewhere else. The guard is an lstat walk of every component plus `O_NOFOLLOW` on the last one.
 *
 * Limit: this protects against accidents and against processes that cannot write to the OMF home. It does
 * not stop a process that can write there and swaps a component for a link between the walk and the
 * open; the hash chain and the modes make the same assumption (spec §8).
 */

/** Raised for any symlink below the real OMF root. `relPath` is relative to that root, uses "/", and is never absolute. */
export class SymlinkRefusedError extends Error {
  constructor(readonly relPath: string) {
    super(`symlink found under OMF state: ${relPath}`);
    this.name = "SymlinkRefusedError";
  }
}

export type UnsafePathCode = "outside_root" | "no_follow_unsupported" | "not_regular_file" | "too_large" | "exists" | "missing";

/** Raised for every other refusal. `detail` never contains an absolute path. */
export class UnsafePathError extends Error {
  constructor(
    readonly code: UnsafePathCode,
    detail: string,
  ) {
    super(`unsafe path (${code}): ${detail}`);
    this.name = "UnsafePathError";
  }
}

/** Top-level entries of the project dir that hold working trees and are not walked (symlinks in node_modules are normal). */
export const STATE_TREE_SKIP: readonly string[] = ["worktrees"];

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (err) {
    const code = errnoCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

/** `path` relative to `root`, with "/" separators so a message reads the same on every platform. */
function relPath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

/** The path segments from `root` (exclusive) to `target`; throws `outside_root` when `target` is not under `root`. */
function segmentsBelow(root: string, target: string): string[] {
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new UnsafePathError("outside_root", "path is outside the state root");
  }
  return rel === "" ? [] : rel.split(sep);
}

/** `O_NOFOLLOW`, or a refusal where the platform has none (v0.1 targets macOS and Linux). */
function noFollowFlag(): number {
  const flag: number | undefined = constants.O_NOFOLLOW;
  if (typeof flag !== "number") {
    throw new UnsafePathError("no_follow_unsupported", "O_NOFOLLOW is not available on this platform");
  }
  return flag;
}

/**
 * The only place the home is resolved: `realpathSync.native(omfHome(env))`. A symlinked home (a dotfile
 * manager, `/var -> /private/var`) therefore works, and only entries below the real root are checked.
 * Throws when the home does not exist, so callers that must tolerate that check first.
 */
export function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return realpathSync.native(omfHome(env));
}

/** `root` = `stateRoot(env)`; `dir` = the project dir expressed under that real root. */
export function realProjectDir(location: ProjectLocation, env: NodeJS.ProcessEnv = process.env): { root: string; dir: string } {
  const root = stateRoot(env);
  return { root, dir: join(root, relative(resolve(omfHome(env)), resolve(location.dir))) };
}

/**
 * lstat walk of every component from `root` (exclusive) to `target`. A symlink anywhere, including a
 * dangling one and the last component, throws `SymlinkRefusedError`. A missing component ends the walk:
 * there is nothing yet to refuse.
 */
export function assertNoSymlinksBelow(root: string, target: string): void {
  let current = root;
  const seen: string[] = [];
  for (const segment of segmentsBelow(root, target)) {
    current = join(current, segment);
    seen.push(segment);
    const stat = lstatOrNull(current);
    if (stat === null) return;
    if (stat.isSymbolicLink()) throw new SymlinkRefusedError(seen.join("/"));
  }
}

/**
 * Relative paths (to `root`) of every symlink below `dir`, never followed, sorted. `skip` names top-level
 * entries of `dir` that are not walked; such an entry is still reported when it is itself a link.
 */
export function listSymlinksBelow(root: string, dir: string, options: { skip?: readonly string[] } = {}): string[] {
  const skip = new Set(options.skip ?? []);
  const found: string[] = [];
  const top = lstatOrNull(dir);
  if (top === null || !top.isDirectory()) return found;
  const walk = (current: string, isTop: boolean): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        found.push(relPath(root, path));
      } else if (entry.isDirectory() && !(isTop && skip.has(entry.name))) {
        walk(path, false);
      }
    }
  };
  walk(dir, true);
  return found.sort();
}

/**
 * Creates each missing component below `root` with mode 0700. The mode is applied again with chmod after the
 * mkdir, so the umask cannot loosen it (or tighten it so far that the next component cannot be created).
 * A link or a non-directory component is refused; the component is re-checked after the mkdir because another
 * process may have created it first.
 */
export function mkdirPrivate(root: string, dir: string): void {
  let current = root;
  const seen: string[] = [];
  for (const segment of segmentsBelow(root, dir)) {
    current = join(current, segment);
    seen.push(segment);
    let stat = lstatOrNull(current);
    if (stat === null) {
      try {
        mkdirSync(current, { mode: 0o700 });
        chmodSync(current, 0o700);
      } catch (err) {
        if (errnoCode(err) !== "EEXIST") throw err;
      }
      stat = lstatOrNull(current);
      if (stat === null) throw new UnsafePathError("missing", "a directory could not be created");
    }
    if (stat.isSymbolicLink()) throw new SymlinkRefusedError(seen.join("/"));
    if (!stat.isDirectory()) throw new UnsafePathError("exists", "a path component exists and is not a directory");
  }
}

/** open(2) with the no-follow flag; maps ELOOP to a symlink refusal and the other expected errors to codes. */
function openNoFollow(root: string, file: string, flags: number, mode?: number): number {
  try {
    return openSync(file, flags | noFollowFlag(), mode);
  } catch (err) {
    if (err instanceof UnsafePathError) throw err;
    switch (errnoCode(err)) {
      case "ELOOP":
        throw new SymlinkRefusedError(relPath(root, file));
      case "ENOENT":
        throw new UnsafePathError("missing", "no such file or directory");
      case "EEXIST":
        throw new UnsafePathError("exists", "file already exists");
      default:
        throw err;
    }
  }
}

/** `assertNoSymlinksBelow`, then open(O_RDONLY | O_NOFOLLOW); the opened file must be a regular file of at most `maxBytes`. */
export function readRegularNoFollow(root: string, file: string, maxBytes: number): Buffer {
  assertNoSymlinksBelow(root, file);
  const fd = openNoFollow(root, file, constants.O_RDONLY);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new UnsafePathError("not_regular_file", "not a regular file");
    if (stat.size > maxBytes) throw new UnsafePathError("too_large", `file is larger than ${maxBytes} bytes`);
    const data = readFileSync(fd);
    // The file may have grown between fstat and read.
    if (data.length > maxBytes) throw new UnsafePathError("too_large", `file is larger than ${maxBytes} bytes`);
    return data;
  } finally {
    closeSync(fd);
  }
}

/** open(O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600): never overwrites, never writes through a link; `exists` when present. */
export function writeNewNoFollow(root: string, file: string, data: string | Uint8Array): void {
  assertNoSymlinksBelow(root, file);
  const fd = openNoFollow(root, file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    // The creation mode is filtered by the umask, so set it explicitly.
    fchmodSync(fd, 0o600);
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/**
 * Throws `SymlinkRefusedError` when the path to `<home>/projects/<id>` or anything below it, except
 * `STATE_TREE_SKIP`, is a symlink. Returns quietly when the OMF home does not exist yet: nothing to refuse.
 * Called by `requireProject`, `initProject`, `omf ledger verify` and `omf doctor`, and by the seal and GATE-2
 * library entry points in later tasks. Cost: one lstat/readdir walk of the project's host state per call.
 */
export function assertStateTreeClean(location: ProjectLocation, env: NodeJS.ProcessEnv = process.env): void {
  let real: { root: string; dir: string };
  try {
    real = realProjectDir(location, env);
  } catch (err) {
    const code = errnoCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") return;
    throw err;
  }
  assertNoSymlinksBelow(real.root, real.dir);
  const [first] = listSymlinksBelow(real.root, real.dir, { skip: STATE_TREE_SKIP });
  if (first !== undefined) throw new SymlinkRefusedError(first);
}
