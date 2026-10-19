import { existsSync } from "node:fs";
import { join } from "node:path";
import { LockHeldError, acquireLock, releaseLock } from "../core/lock.js";
import type { ProjectLocation } from "../core/paths.js";
import { GoalFileError, assertGoalId, goalDir, goalFile } from "./goal-file.js";

export const TICK_RUNNING_MESSAGE = "a tick is running; retry";

/** Another tick (or a resume or cancel) holds the goal's tick lock. Callers exit 2 (spec §8). */
export class TickRunningError extends Error {
  constructor() {
    super(TICK_RUNNING_MESSAGE);
    this.name = "TickRunningError";
  }
}

export function tickLockFile(location: ProjectLocation, goalId: string): string {
  return join(goalDir(location.dir, goalId), "tick.lock");
}

/** Throws GoalFileError for a malformed id or a goal with no goal.md, before anything is created. */
export function assertGoalExists(projectDir: string, goalId: string): void {
  assertGoalId(goalId);
  if (!existsSync(goalFile(projectDir, goalId))) {
    throw new GoalFileError(`goal ${goalId} not found; run omf goal new ${goalId}`);
  }
}

/**
 * One tick per goal at a time. `omf goal resume` and `omf goal cancel` take the same lock, so an
 * in-flight tick cannot create work items after `goal.terminated(cancelled)`. The lock records pid and
 * process start time and a crashed holder is reclaimed (core/lock.ts), so no cleanup command is needed.
 */
export async function withTickLock<T>(location: ProjectLocation, goalId: string, fn: () => Promise<T> | T): Promise<T> {
  assertGoalExists(location.dir, goalId);
  const file = tickLockFile(location, goalId);
  try {
    acquireLock(file);
  } catch (err) {
    if (err instanceof LockHeldError) throw new TickRunningError();
    throw err;
  }
  try {
    return await fn();
  } finally {
    releaseLock(file);
  }
}
