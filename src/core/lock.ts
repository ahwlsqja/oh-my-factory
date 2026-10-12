import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";

export interface LockOwner {
  pid: number;
  start_time: string | null;
  acquired_at: string;
}

/** A lock file with no readable owner is presumed mid-write for this long. */
const UNREADABLE_GRACE_MS = 5000;

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
    if (typeof parsed.pid !== "number") return null;
    return { pid: parsed.pid, start_time: parsed.start_time ?? null, acquired_at: parsed.acquired_at ?? "" };
  } catch {
    return null;
  }
}

function canReclaim(path: string): boolean {
  const owner = readOwner(path);
  if (owner) return isStale(owner);
  try {
    return Date.now() - statSync(path).mtimeMs > UNREADABLE_GRACE_MS;
  } catch {
    return true;
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

export function acquireLock(path: string): LockOwner {
  const owner: LockOwner = {
    pid: process.pid,
    start_time: processStartTime(process.pid),
    acquired_at: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const fd = tryOpenExclusive(path);
    if (fd === null) {
      if (!canReclaim(path)) throw new LockHeldError(path, readOwner(path));
      rmSync(path, { force: true });
      continue;
    }
    try {
      writeSync(fd, JSON.stringify(owner));
    } finally {
      closeSync(fd);
    }
    return owner;
  }
  throw new LockHeldError(path, readOwner(path));
}

export function releaseLock(path: string): void {
  const owner = readOwner(path);
  if (owner && owner.pid !== process.pid) {
    throw new Error(`refusing to release a lock owned by pid ${owner.pid}: ${path}`);
  }
  rmSync(path, { force: true });
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Runs `fn` while holding the lock. Waits up to `timeoutMs` for a held lock. */
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
  try {
    return fn();
  } finally {
    releaseLock(path);
  }
}
