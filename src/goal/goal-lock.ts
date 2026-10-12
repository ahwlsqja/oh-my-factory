import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalize } from "../core/canonical-json.js";
import { budgetState, declareBudget } from "../core/budget.js";
import { Ledger, type LedgerEvent } from "../core/ledger.js";
import { LockHeldError, withLockSync } from "../core/lock.js";
import type { ProjectLocation } from "../core/paths.js";
import { writePrivateFile } from "../core/private-fs.js";
import { validate } from "../core/schema.js";
import { type GoalSemantic, assertGoalId, readGoal, referencedMetrics, semanticHash, semanticOf } from "./goal-file.js";
import { parseDuration } from "./duration.js";
import { type BandsLockInfo, bandsLockInfo } from "./bands.js";
import { changedPathsSince, headCommit, matchWatched } from "./git.js";
import { type MetricDefinition, definitionOf, metricSha256, readProposal, writeLock } from "./metrics.js";

/** The locked goal: the semantic fields J1 approved, and the commit the watched paths are compared with. */
export interface GoalLock {
  schema_version: 1;
  goal_id: string;
  regime: number;
  semantic_sha256: string;
  head_commit: string;
  metrics: string[];
  approved_by: string;
  approved_at: string;
  semantic: GoalSemantic;
  /** metric id to the sha256 of its bands config, or null when it had no bands file; absent on locks written before M2b. */
  bands?: Record<string, string | null>;
}

/** The latest J1 approval of a goal, as the ledger records it. */
export interface GoalApproval {
  regime: number;
  semantic_sha256: string;
  head_commit: string;
  metrics: string[];
  approved_by: string;
  approved_at: string;
  /** When the goal was first approved; wall time is counted from here (spec §4.4). */
  first_approved_at: string;
  /** Hash of the bands map J1 locked; null for an approval written before M2b, whose bands were never locked. */
  bands_sha256: string | null;
  /** The wall time J1 approved, for example `72h`; null for an approval written before M2b. */
  wall_time: string | null;
}

/** What the person was shown at approval; the lock is refused if the goal or a metric no longer matches. */
export interface ApprovalExpectation {
  semantic_sha256: string;
  /** metric id to the sha256 of the proposal that was shown. */
  metrics: Record<string, string>;
  /** Hash of the bands that were shown; when present, lockGoal refuses if the bands moved since. */
  bands_sha256?: string;
}

export class ApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalError";
  }
}

export class GoalLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalLockError";
  }
}

export function goalLockFile(projectDir: string, goalId: string): string {
  return join(projectDir, "vault", "metrics", goalId, "goal.lock.json");
}

export function readGoalLock(projectDir: string, goalId: string): GoalLock | null {
  const file = goalLockFile(projectDir, goalId);
  if (!existsSync(file)) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new GoalLockError(`goal lock is not valid JSON: ${file}`);
  }
  const check = validate("goal-lock.schema.json", data);
  if (!check.ok) throw new GoalLockError(`goal lock is invalid (${check.errors}): ${file}`);
  return data as GoalLock;
}

function invalidApproval(event: LedgerEvent, why: string): Error {
  return new Error(`invalid goal.approved event at seq ${event.seq}: ${why}`);
}

/** An optional string field of a goal.approved payload: absent reads as null, present must match `pattern`. */
function optionalField(event: LedgerEvent, key: string, pattern: RegExp): string | null {
  const value = event.payload[key];
  if (value === undefined) return null;
  if (typeof value !== "string" || !pattern.test(value)) throw invalidApproval(event, `malformed ${key}`);
  return value;
}

/**
 * The latest goal.approved event for the goal, or null. An approval written by a non-person, or with a
 * malformed payload, was written outside lockGoal and stops the line.
 */
export function latestApproval(events: readonly LedgerEvent[], goalId: string): GoalApproval | null {
  let latest: GoalApproval | null = null;
  let firstApprovedAt: string | null = null;
  for (const event of events) {
    if (event.type !== "goal.approved" || event.payload.goal_id !== goalId) continue;
    if (!event.actor.startsWith("human:")) throw invalidApproval(event, `goal.approved by ${event.actor}`);
    const { regime, semantic_sha256, head_commit, metrics } = event.payload;
    if (
      typeof regime !== "number" ||
      typeof semantic_sha256 !== "string" ||
      typeof head_commit !== "string" ||
      !Array.isArray(metrics) ||
      !metrics.every((id) => typeof id === "string")
    ) {
      throw invalidApproval(event, "malformed payload");
    }
    const bands_sha256 = optionalField(event, "bands_sha256", /^[0-9a-f]{64}$/);
    const wall_time = optionalField(event, "wall_time", /^[1-9][0-9]*(m|h|d)$/);
    firstApprovedAt ??= event.ts;
    latest = {
      regime,
      semantic_sha256,
      head_commit,
      metrics: metrics as string[],
      approved_by: event.actor,
      approved_at: event.ts,
      first_approved_at: firstApprovedAt,
      bands_sha256,
      wall_time,
    };
  }
  return latest;
}

function requireShown(
  expected: ApprovalExpectation,
  front: GoalSemantic,
  proposals: readonly MetricDefinition[],
  bands: BandsLockInfo,
): void {
  const shown = Object.entries(expected.metrics).sort(([a], [b]) => a.localeCompare(b));
  const current = proposals.map((proposal) => [proposal.metric_id, metricSha256(proposal)] as const).sort(([a], [b]) => a.localeCompare(b));
  const bandsMoved = expected.bands_sha256 !== undefined && expected.bands_sha256 !== bands.sha256;
  if (semanticHash(front) !== expected.semantic_sha256 || canonicalize(shown) !== canonicalize(current) || bandsMoved) {
    throw new ApprovalError("the goal, a metric or a bands file changed after it was shown; nothing was approved. Review it and approve again");
  }
}

/**
 * Re-approval does not move the budgets: rounds are enforced from the ledger and wall time from the first
 * approval, and raising either is a J8 decision. Refusing here keeps what the person sees at approval equal
 * to what is enforced.
 */
function requireBudgetsUnchanged(
  location: ProjectLocation,
  ledger: Ledger,
  goalId: string,
  budget: { rounds: number; wall_time: string },
  previous: GoalApproval,
): void {
  const state = budgetState(ledger, goalId, "rounds");
  if (state !== null && budget.rounds !== state.declared + state.raised) {
    throw new ApprovalError(
      `goal.md says ${budget.rounds} rounds but the enforced budget is ${state.declared + state.raised}; re-approval does not change it. ` +
        "Restore goal.md, or raise the budget as a separate J8 decision",
    );
  }
  // The ledger records the approved wall time (D26); only a pre-M2b approval falls back to the lock file.
  const approved = previous.wall_time ?? lockedWallTime(location, goalId, previous);
  if (approved !== null && parseDuration(budget.wall_time) !== parseDuration(approved)) {
    throw new ApprovalError(
      `goal.md says ${budget.wall_time} wall time but the approved wall time is ${approved}; re-approval does not change it. ` +
        "Restore goal.md, or raise the budget as a separate J8 decision",
    );
  }
}

/** The wall time in a pre-M2b goal lock, or null when the lock is missing, unreadable or does not match the ledger (it is being repaired). */
function lockedWallTime(location: ProjectLocation, goalId: string, previous: GoalApproval): string | null {
  let locked: GoalLock | null = null;
  try {
    locked = readGoalLock(location.dir, goalId);
  } catch (err) {
    if (!(err instanceof GoalLockError)) throw err;
  }
  if (locked === null || locked.semantic_sha256 !== previous.semantic_sha256) return null;
  return locked.semantic.budget.wall_time;
}

/** How long a second approval of the same goal waits for the first one to finish. */
const APPROVE_LOCK_WAIT_MS = 10_000;

function approveLockFile(projectDir: string, goalId: string): string {
  return join(projectDir, "vault", "metrics", goalId, "approve.lock");
}

/**
 * J1: locks the goal's semantic fields and every metric it refers to, as a new regime (spec §4.1,
 * §4.2). Lock files are written before their ledger events, and goal.approved comes last. A crash part
 * way leaves a lock that does not match the ledger, which audit reports and approving again repairs.
 * The rounds budget is declared on the first approval only; raising it later is a separate J8 decision.
 *
 * The whole approval runs under `vault/metrics/<goal>/approve.lock`. The regime is read once before the
 * lock is taken and again after: if it moved, another approval finished while this one waited, so what
 * the caller decided on is stale and nothing is written. Two racing approvals therefore never both write
 * lock files, `metric.locked` events or a `goal.approved` for the same regime.
 */
export function lockGoal(
  location: ProjectLocation,
  goalId: string,
  actor: string,
  now: () => Date = () => new Date(),
  expected?: ApprovalExpectation,
): GoalApproval {
  if (!actor.startsWith("human:")) throw new ApprovalError(`only a person approves a goal (J1); actor was ${actor}`);
  assertGoalId(goalId);
  const ledger = new Ledger(location.dir, now);
  const seen = latestApproval(ledger.readVerified(), goalId);
  const lockPath = approveLockFile(location.dir, goalId);
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    return withLockSync(
      lockPath,
      () => lockGoalSerialized(location, ledger, goalId, actor, now, expected, seen),
      APPROVE_LOCK_WAIT_MS,
    );
  } catch (err) {
    if (err instanceof LockHeldError && err.path === lockPath) {
      throw new ApprovalError(`another approval of ${goalId} is in progress; nothing was approved. Try again`);
    }
    throw err;
  }
}

/** The body of lockGoal, run while this process holds the goal's approve.lock. `seen` is the approval before the wait. */
function lockGoalSerialized(
  location: ProjectLocation,
  ledger: Ledger,
  goalId: string,
  actor: string,
  now: () => Date,
  expected: ApprovalExpectation | undefined,
  seen: GoalApproval | null,
): GoalApproval {
  const previous = latestApproval(ledger.readVerified(), goalId);
  if ((previous?.regime ?? 0) !== (seen?.regime ?? 0)) {
    throw new ApprovalError(
      `another approval of ${goalId} ran concurrently; nothing was approved. Review the goal and approve again`,
    );
  }
  const goal = readGoal(location.dir, goalId);
  if (previous !== null) requireBudgetsUnchanged(location, ledger, goalId, goal.front.budget, previous);
  const metrics = referencedMetrics(goal.front);
  const proposals = metrics.map((id) => {
    const proposal = readProposal(location.dir, id);
    if (proposal === null) throw new ApprovalError(`metric ${id} has no proposal; run omf metric propose ${id}`);
    return proposal;
  });
  const bands = bandsLockInfo(location.dir, goalId, metrics);
  if (expected !== undefined) requireShown(expected, goal.front, proposals, bands);
  const targetProposal = proposals[0];
  if (targetProposal !== undefined && targetProposal.unit !== goal.front.target.unit) {
    throw new ApprovalError(
      `target unit ${goal.front.target.unit} does not match metric ${targetProposal.metric_id} unit ${targetProposal.unit}`,
    );
  }

  // The approval pins a commit; uncommitted edits to watched paths would read as a regime change forever.
  const head_commit = headCommit(location.repo);
  const dirty = changedPathsSince(location.repo, head_commit);
  const dirtyWatched = [...new Set(proposals.flatMap((proposal) => matchWatched(dirty, proposal.watched_paths)))];
  if (dirtyWatched.length > 0) {
    throw new ApprovalError(`commit or revert changes to watched paths before approving: ${dirtyWatched.join(", ")}`);
  }

  const regime = previous === null ? 1 : previous.regime + 1;
  const approvedAt = now().toISOString();
  for (const proposal of proposals) {
    const sha256 = metricSha256(proposal);
    writeLock(location.dir, {
      schema_version: 1,
      goal_id: goalId,
      ...definitionOf(proposal),
      owner: proposal.owner,
      approved_by: actor,
      approved_at: approvedAt,
      sha256,
      regime,
    });
    ledger.append({ actor, type: "metric.locked", payload: { goal_id: goalId, metric_id: proposal.metric_id, sha256, regime } });
  }

  const semantic = semanticOf(goal.front);
  const semantic_sha256 = semanticHash(semantic);
  const lock: GoalLock = {
    schema_version: 1,
    goal_id: goalId,
    regime,
    semantic_sha256,
    head_commit,
    metrics,
    approved_by: actor,
    approved_at: approvedAt,
    semantic,
    bands: bands.map,
  };
  const check = validate("goal-lock.schema.json", lock);
  if (!check.ok) throw new GoalLockError(`invalid goal lock: ${check.errors}`);
  writePrivateFile(goalLockFile(location.dir, goalId), `${JSON.stringify(lock, null, 2)}\n`);
  const approved = ledger.append({
    actor,
    type: "goal.approved",
    payload: {
      goal_id: goalId,
      regime,
      semantic_sha256,
      head_commit,
      metrics,
      bands_sha256: bands.sha256,
      wall_time: goal.front.budget.wall_time,
    },
  });
  if (budgetState(ledger, goalId, "rounds") === null) {
    declareBudget(ledger, goalId, "rounds", goal.front.budget.rounds, actor);
  }
  return {
    regime,
    semantic_sha256,
    head_commit,
    metrics,
    approved_by: actor,
    approved_at: approved.ts,
    first_approved_at: previous?.first_approved_at ?? approved.ts,
    bands_sha256: bands.sha256,
    wall_time: goal.front.budget.wall_time,
  };
}
