import { BudgetError, type BudgetState, budgetStateFromEvents } from "../core/budget.js";
import { Ledger, type LedgerEvent } from "../core/ledger.js";
import type { ProjectLocation } from "../core/paths.js";
import { canonicalize, sha256Hex } from "../core/canonical-json.js";
import { BandsError, bandsLockInfo } from "./bands.js";
import { staleReason } from "./stale-mark.js";
import { parseDuration } from "./duration.js";
import { wallTimeLimitMs } from "./wall-time.js";
import { type GoalFront, GoalFileError, readGoal, referencedMetrics, semanticHash } from "./goal-file.js";
import { type GoalApproval, type GoalLock, GoalLockError, latestApproval, readGoalLock } from "./goal-lock.js";
import { changedPathsSince, matchWatched } from "./git.js";
import {
  MetricError,
  type MetricLock,
  lockedSha256,
  metricSha256,
  readLock,
  readProposal,
  unpinnedImageProblem,
} from "./metrics.js";

/**
 * `tampered`: an approval exists but a lock, the budget events or the goal lock do not verify against the
 * ledger (E1). It is never `approved`, so nothing that branches on the state treats the goal as sound;
 * approving again repairs it.
 */
export type GoalState = "invalid" | "draft" | "approved" | "needs_reapproval" | "tampered";

export interface AuditReport {
  goal_id: string;
  state: GoalState;
  /** Anything here stops measurement: the goal file is unusable or a lock does not match the ledger (state `tampered` once approved). */
  problems: string[];
  /** Anything here means J1 must approve again before a candidate (spec §4.1, §4.6). */
  regime_changes: string[];
  /** The watched paths behind the "watched path changed" entries, for showing the diff. */
  watched_paths_changed: string[];
  approval: GoalApproval | null;
  /** The locked goal and metrics, present only when every lock verifies. */
  locked: { goal: GoalLock; metrics: MetricLock[] } | null;
  budget: BudgetState | null;
  wall_time_exceeded: boolean;
  /** Advice that does not stop approval or measurement, for example a wall time that cannot cover the minimum observation. */
  warnings: string[];
}

/**
 * Success needs readings that span the minimum observation, and wall time is calendar time from the first
 * approval, so a wall time at or below the minimum observation can never reach success inside its own cap.
 * This only advises: the person may still approve, then raise the cap (J8) and resume (J6) when it runs out.
 */
export function observationWarning(minObservation: string, wallLimitMs: number, wallLabel: string): string | null {
  let observationMs: number;
  try {
    observationMs = parseDuration(minObservation);
  } catch {
    return null;
  }
  if (wallLimitMs > observationMs) return null;
  return (
    `wall time ${wallLabel} is not longer than the minimum observation ${minObservation}, so the goal cannot reach ` +
    "success before wall time runs out; set a longer wall_time in goal.md before approving, or later raise it " +
    "with omf budget raise <goal_id> wall_time <duration> and continue with omf goal resume <goal_id>"
  );
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
  // The bands map in the lock must be the one the ledger approved; a legacy approval locked none (carried item 2).
  if (
    approval.bands_sha256 !== null &&
    (lock.bands === undefined || sha256Hex(canonicalize(lock.bands)) !== approval.bands_sha256)
  ) {
    problems.push("goal lock bands tampered");
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
    if (
      sha !== lock.sha256 ||
      sha !== lockedSha256(events, goalId, id, approval.regime) ||
      lock.regime !== approval.regime
    ) {
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
      if (proposal !== null && metricSha256(proposal) !== lock.sha256)
        changes.push(`metric ${lock.metric_id} definition changed`);
    } catch (err) {
      if (!(err instanceof MetricError)) throw err;
      changes.push(`metric ${lock.metric_id} proposal is unreadable`);
    }
  }
  return changes;
}

function watchedChanges(
  repo: string,
  commit: string,
  locks: readonly MetricLock[],
): { messages: string[]; paths: string[] } {
  if (locks.every((lock) => lock.watched_paths.length === 0)) return { messages: [], paths: [] };
  let changed: string[];
  try {
    changed = changedPathsSince(repo, commit);
  } catch {
    return { messages: [`approval commit ${commit.slice(0, 12)} is no longer in the repository`], paths: [] };
  }
  const hits = locks.flatMap((lock) =>
    matchWatched(changed, lock.watched_paths).map((path) => ({ path, id: lock.metric_id })),
  );
  return {
    messages: hits.map(({ path, id }) => `watched path changed: ${path} (${id})`),
    paths: [...new Set(hits.map((hit) => hit.path))],
  };
}

/**
 * Metrics whose bands file is not what J1 locked: edited, created or deleted. An unreadable file counts as
 * changed (measureGoal will stop on it with the parse error). An approval from before M2b locked no bands, so
 * there is nothing to compare and nothing is flagged.
 */
function bandsChanges(dir: string, goalId: string, approval: GoalApproval, lock: GoalLock): string[] {
  if (approval.bands_sha256 === null) return [];
  const locked = lock.bands ?? {};
  const changed: string[] = [];
  for (const id of [...approval.metrics].sort()) {
    let current: string | null;
    try {
      current = bandsLockInfo(dir, goalId, [id]).map[id] ?? null;
    } catch (err) {
      if (!(err instanceof BandsError)) throw err;
      changed.push(id);
      continue;
    }
    if (current !== (locked[id] ?? null)) changed.push(id);
  }
  return changed.length === 0 ? [] : [`bands changed: ${changed.join(", ")}`];
}

function wallWarning(minObservation: string, wallTime: string): string | null {
  try {
    return observationWarning(minObservation, parseDuration(wallTime), wallTime);
  } catch {
    return null;
  }
}

function draftProblems(dir: string, front: GoalFront): string[] {
  const problems: string[] = [];
  for (const id of referencedMetrics(front)) {
    try {
      const proposal = readProposal(dir, id);
      if (proposal === null) {
        problems.push(`metric ${id} has no proposal; run omf metric propose ${id}`);
        continue;
      }
      // A proposal made before the digest rule may hold a tag; J1 would refuse to lock it, so it is not ready.
      const unpinned = unpinnedImageProblem(proposal);
      if (unpinned !== null) problems.push(`${unpinned}; propose the metric again with a digest`);
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
    watched_paths_changed: [],
    approval: null,
    locked: null,
    budget: null,
    wall_time_exceeded: false,
    warnings: [],
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
    const draftWarning = wallWarning(front.prereg.min_observation, front.budget.wall_time);
    if (draftWarning !== null) report.warnings.push(draftWarning);
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
  const watched = watchedChanges(location.repo, approval.head_commit, metricLocks ?? []);
  report.regime_changes.push(...watched.messages);
  report.watched_paths_changed = watched.paths;

  if (goalLock !== null) report.regime_changes.push(...bandsChanges(location.dir, goalId, approval, goalLock));
  // D21: a goal that refresh marked stale needs J1 again; the new approval is what clears the mark.
  const stale = staleReason(events, goalId);
  if (stale !== null) report.regime_changes.push(stale);

  // Wall time comes from the ledger (the approved value plus J8 raises), so a deleted or edited lock cannot move it.
  if (goalLock !== null || approval.wall_time !== null) {
    const limit = wallTimeLimitMs(events, goalId, approval, goalLock);
    report.wall_time_exceeded = now.getTime() - Date.parse(approval.first_approved_at) > limit;
    const observation = goalLock?.semantic.prereg.min_observation ?? front.prereg.min_observation;
    const warning = observationWarning(observation, limit, `limit of ${Math.round(limit / 60_000)}m`);
    if (warning !== null) report.warnings.push(warning);
  }
  // Problems first: a goal whose locks do not verify is tampered even when it also has regime changes.
  if (report.problems.length > 0) report.state = "tampered";
  else report.state = report.regime_changes.length > 0 ? "needs_reapproval" : "approved";
  return report;
}
