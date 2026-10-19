import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type LockOwner, acquireLock, isStale, releaseLock, withLockSync } from "../core/lock.js";

/**
 * Two locks per work item (spec §11.1), because they answer two different questions:
 *
 * - `claim.lock` says "a W run owns this item" and lives as long as the run. Only `claimItem` and
 *   `releaseItem` touch it.
 * - `item.lock` is a millisecond mutex around a read-modify-write of item.md. Every store write verb
 *   takes it, and nothing else does.
 *
 * Because they are separate files, a person's veto (item.lock only) succeeds while a run holds the claim,
 * and the run's own store calls never conflict with its claim.
 */
export function claimFile(itemDir: string): string {
  return join(itemDir, "claim.lock");
}

export function itemLockFile(itemDir: string): string {
  return join(itemDir, "item.lock");
}

export interface ClaimStatus {
  held: boolean;
  owner: LockOwner | null;
  stale: boolean;
}

function parseOwner(text: string): LockOwner | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const owner = parsed as Partial<LockOwner>;
  if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0) return null;
  return {
    pid: owner.pid,
    start_time: typeof owner.start_time === "string" ? owner.start_time : null,
    acquired_at: typeof owner.acquired_at === "string" ? owner.acquired_at : "",
  };
}

/**
 * Whether a live run owns the item. A claim whose process is gone, or whose pid now belongs to another
 * process, is stale and not held. A claim file with no readable owner is treated as held: it is probably
 * being written, and `acquireLock` reclaims it after its grace period if it is not.
 */
export function claimStatus(itemDir: string): ClaimStatus {
  let text: string;
  try {
    text = readFileSync(claimFile(itemDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { held: false, owner: null, stale: false };
    throw err;
  }
  const owner = parseOwner(text);
  if (owner === null) return { held: true, owner: null, stale: false };
  const stale = isStale(owner);
  return { held: !stale, owner, stale };
}

/** Takes the claim for this process. Throws LockHeldError while another live process owns it. Used by the W line only. */
export function claimItem(itemDir: string): LockOwner {
  return acquireLock(claimFile(itemDir));
}

/** Releases the claim; refuses if another process owns it. */
export function releaseItem(itemDir: string): void {
  releaseLock(claimFile(itemDir));
}

/**
 * Runs `fn` under `item.lock`. Every StateStore write verb uses it, including veto and cancel, which use
 * nothing else. Not reentrant, like withLockSync: `fn` must not call another store write verb.
 */
export function withItemLock<T>(itemDir: string, fn: () => T, timeoutMs = 2000): T {
  return withLockSync(itemLockFile(itemDir), fn, timeoutMs);
}
