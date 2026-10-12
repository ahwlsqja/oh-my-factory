import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";

export interface LockOwner {
  pid: number;
  start_time: string | null;
  acquired_at: string;
}

/**
 * A lock file with no readable owner is presumed mid-write for this long. A guard file is held for
 * microseconds. Both stay well inside withLockSync's default 2s wait, so a crash heals within one wait.
 */
const UNREADABLE_GRACE_MS = 1000;
const RECLAIM_GUARD_STALE_MS = 1000;

export class LockHeldError extends Error {
  constructor(
    readonly path: string,
    readonly owner: LockOwner | null,
  ) {
    super(`lock is held: ${path}${owner ? ` (pid ${owner.pid})` : ""}`);
    this.name = "LockHeldError";
  }
}

/** Process start time from `ps`, forced to the C locale so it compares reliably. */
export function processStartTime(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C" },
    });
    const value = out.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

let ownStartTime: string | null | undefined;

/** This process's start time never changes, so `ps` runs at most once per process when it succeeds. */
function ownProcessStartTime(): string | null {
  if (ownStartTime === undefined || ownStartTime === null) ownStartTime = processStartTime(process.pid);
  return ownStartTime;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Stale when the owner is gone, or when its pid now belongs to a different process. */
export function isStale(owner: LockOwner): boolean {
  if (!isAlive(owner.pid)) return true;
  if (owner.start_time === null) return false;
  const current = processStartTime(owner.pid);
  return current !== null && current !== owner.start_time;
}

function readOwner(path: string): LockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockOwner>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    return { pid: parsed.pid, start_time: parsed.start_time ?? null, acquired_at: parsed.acquired_at ?? "" };
  } catch {
    return null;
  }
}

/** True only when the current lock file is provably stale. A vanished file is not stale: nothing to remove. */
function canReclaim(path: string): boolean {
  const owner = readOwner(path);
  if (owner) return isStale(owner);
  try {
    return Date.now() - statSync(path).mtimeMs > UNREADABLE_GRACE_MS;
  } catch {
    return false;
  }
}

function tryOpenExclusive(path: string): number | null {
  try {
    return openSync(path, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw err;
  }
}

/**
 * Clears the way for another exclusive open. Returns false when the lock is held.
 * Holds `<path>.reclaim` while it re-checks staleness. A stale owner never releases, and only
 * guard holders remove someone else's lock, so the file cannot be replaced between check and removal.
 * Known limit: two processes breaking the same crashed guard at once can race (crash-only, narrow).
 */
function tryReclaim(path: string): boolean {
  const guard = `${path}.reclaim`;
  const fd = tryOpenExclusive(guard);
  if (fd === null) {
    try {
      if (Date.now() - statSync(guard).mtimeMs > RECLAIM_GUARD_STALE_MS) rmSync(guard, { force: true });
    } catch {
      // the guard vanished; another reclaimer finished
    }
    return false;
  }
  closeSync(fd);
  try {
    if (!existsSync(path)) return true;
    if (!canReclaim(path)) return false;
    rmSync(path, { force: true });
    return true;
  } finally {
    rmSync(guard, { force: true });
  }
}

export function acquireLock(path: string): LockOwner {
  const owner: LockOwner = {
    pid: process.pid,
    start_time: ownProcessStartTime(),
    acquired_at: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const fd = tryOpenExclusive(path);
    if (fd === null) {
      if (!tryReclaim(path)) throw new LockHeldError(path, readOwner(path));
      continue;
    }
    try {
      writeSync(fd, JSON.stringify(owner));
    } catch (err) {
      closeSync(fd);
      rmSync(path, { force: true });
      throw err;
    }
    closeSync(fd);
    return owner;
  }
  throw new LockHeldError(path, readOwner(path));
}

/** Removes the lock only if this process (same pid and start time) owns it. */
export function releaseLock(path: string): void {
  const owner = readOwner(path);
  if (owner) {
    const mine = owner.pid === process.pid && (owner.start_time === null || owner.start_time === ownProcessStartTime());
    if (!mine) throw new Error(`refusing to release a lock owned by pid ${owner.pid}: ${path}`);
  }
  rmSync(path, { force: true });
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs `fn` while holding the lock, waiting up to `timeoutMs` for a held lock.
 * Not reentrant: nesting on the same path in one process waits out the timeout and throws.
 */
export function withLockSync<T>(path: string, fn: () => T, timeoutMs = 2000): T {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      acquireLock(path);
      break;
    } catch (err) {
      if (!(err instanceof LockHeldError) || Date.now() >= deadline) throw err;
      sleepSync(20);
    }
  }
  let result: T;
  try {
    result = fn();
  } catch (err) {
    try {
      releaseLock(path);
    } catch {
      // the callback's error is the one to report
    }
    throw err;
  }
  releaseLock(path);
  return result;
}
