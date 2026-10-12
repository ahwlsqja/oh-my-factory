import { BudgetError, type BudgetState, budgetStateFromEvents } from "../core/budget.js";
import { Ledger, type LedgerEvent } from "../core/ledger.js";
import type { ProjectLocation } from "../core/paths.js";
import { parseDuration } from "./duration.js";
import { type GoalFront, GoalFileError, readGoal, referencedMetrics, semanticHash } from "./goal-file.js";
import { type GoalApproval, type GoalLock, GoalLockError, latestApproval, readGoalLock } from "./goal-lock.js";
import { changedPathsSince, matchWatched } from "./git.js";
import { MetricError, type MetricLock, lockedSha256, metricSha256, readLock, readProposal } from "./metrics.js";

export type GoalState = "invalid" | "draft" | "approved" | "needs_reapproval";

export interface AuditReport {
  goal_id: string;
  state: GoalState;
  /** Anything here stops measurement: the goal file is unusable or a lock does not match the ledger. */
  problems: string[];
  /** Anything here means J1 must approve again before a candidate (spec §4.1, §4.6). */
  regime_changes: string[];
  approval: GoalApproval | null;
  /** The locked goal and metrics, present only when every lock verifies. */
  locked: { goal: GoalLock; metrics: MetricLock[] } | null;
  budget: BudgetState | null;
  wall_time_exceeded: boolean;
}

function safeSemanticHash(lock: GoalLock): string | null {
  try {
    return semanticHash(lock.semantic);
  } catch {
    return null;
  }
}

function verifiedGoalLock(dir: string, goalId: string, approval: GoalApproval, problems: string[]): GoalLock | null {
  let lock: GoalLock | null;
  try {
    lock = readGoalLock(dir, goalId);
  } catch (err) {
    if (!(err instanceof GoalLockError)) throw err;
    problems.push(err.message);
    return null;
  }
  if (lock === null) {
    problems.push(`goal lock missing: ${goalId}`);
    return null;
  }
  if (
    lock.regime !== approval.regime ||
    lock.semantic_sha256 !== approval.semantic_sha256 ||
    safeSemanticHash(lock) !== approval.semantic_sha256
  ) {
    problems.push(`goal lock tampered: ${goalId}`);
    return null;
  }
  return lock;
}

function verifiedMetricLocks(
  dir: string,
  goalId: string,
  approval: GoalApproval,
  events: readonly LedgerEvent[],
  problems: string[],
): MetricLock[] | null {
  const locks: MetricLock[] = [];
  let intact = true;
  for (const id of approval.metrics) {
    let lock: MetricLock | null;
    try {
      lock = readLock(dir, goalId, id);
    } catch (err) {
      if (!(err instanceof MetricError)) throw err;
      problems.push(err.message);
      intact = false;
      continue;
    }
    if (lock === null) {
      problems.push(`metric lock missing: ${id}`);
      intact = false;
      continue;
    }
    const sha = metricSha256(lock);
    if (sha !== lock.sha256 || sha !== lockedSha256(events, goalId, id) || lock.regime !== approval.regime) {
      problems.push(`metric lock tampered: ${id}`);
      intact = false;
      continue;
    }
    locks.push(lock);
  }
  return intact ? locks : null;
}

function definitionChanges(dir: string, locks: readonly MetricLock[]): string[] {
  const changes: string[] = [];
  for (const lock of locks) {
    try {
      const proposal = readProposal(dir, lock.metric_id);
      if (proposal !== null && metricSha256(proposal) !== lock.sha256) changes.push(`metric ${lock.metric_id} definition changed`);
    } catch (err) {
      if (!(err instanceof MetricError)) throw err;
      changes.push(`metric ${lock.metric_id} proposal is unreadable`);
    }
  }
  return changes;
}

function watchedChanges(repo: string, commit: string, locks: readonly MetricLock[]): string[] {
  if (locks.every((lock) => lock.watched_paths.length === 0)) return [];
  let changed: string[];
  try {
    changed = changedPathsSince(repo, commit);
  } catch {
    return [`approval commit ${commit.slice(0, 12)} is no longer in the repository`];
  }
  return locks.flatMap((lock) =>
    matchWatched(changed, lock.watched_paths).map((path) => `watched path changed: ${path} (${lock.metric_id})`),
  );
}

function draftProblems(dir: string, front: GoalFront): string[] {
  const problems: string[] = [];
  for (const id of referencedMetrics(front)) {
    try {
      if (readProposal(dir, id) === null) problems.push(`metric ${id} has no proposal; run omf metric propose ${id}`);
    } catch (err) {
      if (!(err instanceof MetricError)) throw err;
      problems.push(err.message);
    }
  }
  return problems;
}

/**
 * Read-only audit of one goal (spec §4.4 step 1). A broken ledger chain throws. Lock mismatches are
 * problems that stop measurement (E1). Edits to goal.md, to a locked metric's proposal or to a watched
 * path are regime changes: measurement continues and is labeled, and J1 must approve again.
 */
export function auditGoal(location: ProjectLocation, goalId: string, now: Date = new Date()): AuditReport {
  const events = new Ledger(location.dir).readVerified();
  const report: AuditReport = {
    goal_id: goalId,
    state: "invalid",
    problems: [],
    regime_changes: [],
    approval: null,
    locked: null,
    budget: null,
    wall_time_exceeded: false,
  };

  let front: GoalFront;
  try {
    front = readGoal(location.dir, goalId).front;
  } catch (err) {
    if (!(err instanceof GoalFileError)) throw err;
    report.problems.push(err.message);
    return report;
  }

  const approval = latestApproval(events, goalId);
  if (approval === null) {
    report.state = "draft";
    report.problems.push(...draftProblems(location.dir, front));
    return report;
  }
  report.approval = approval;

  try {
    report.budget = budgetStateFromEvents(events, goalId, "rounds");
  } catch (err) {
    if (!(err instanceof BudgetError)) throw err;
    report.problems.push(err.message);
  }

  const goalLock = verifiedGoalLock(location.dir, goalId, approval, report.problems);
  const metricLocks = verifiedMetricLocks(location.dir, goalId, approval, events, report.problems);
  if (goalLock !== null && metricLocks !== null) report.locked = { goal: goalLock, metrics: metricLocks };

  if (semanticHash(front) !== approval.semantic_sha256) report.regime_changes.push("goal.md changed since approval");
  report.regime_changes.push(...definitionChanges(location.dir, metricLocks ?? []));
  report.regime_changes.push(...watchedChanges(location.repo, approval.head_commit, metricLocks ?? []));

  if (goalLock !== null) {
    const wallTime = parseDuration(goalLock.semantic.budget.wall_time);
    report.wall_time_exceeded = now.getTime() - Date.parse(approval.first_approved_at) > wallTime;
  }
  report.state = report.regime_changes.length > 0 ? "needs_reapproval" : "approved";
  return report;
}
