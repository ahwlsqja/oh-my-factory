import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { budgetState, declareBudget } from "../core/budget.js";
import { Ledger, type LedgerEvent } from "../core/ledger.js";
import type { ProjectLocation } from "../core/paths.js";
import { writePrivateFile } from "../core/private-fs.js";
import { validate } from "../core/schema.js";
import { type GoalSemantic, readGoal, referencedMetrics, semanticHash, semanticOf } from "./goal-file.js";
import { changedPathsSince, headCommit, matchWatched } from "./git.js";
import { definitionOf, metricSha256, readProposal, writeLock } from "./metrics.js";

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
    firstApprovedAt ??= event.ts;
    latest = {
      regime,
      semantic_sha256,
      head_commit,
      metrics: metrics as string[],
      approved_by: event.actor,
      approved_at: event.ts,
      first_approved_at: firstApprovedAt,
    };
  }
  return latest;
}

/**
 * J1: locks the goal's semantic fields and every metric it refers to, as a new regime (spec §4.1,
 * §4.2). Lock files are written before their ledger events, and goal.approved comes last. A crash part
 * way leaves a lock that does not match the ledger, which audit reports and approving again repairs.
 * The rounds budget is declared on the first approval only; raising it later is a separate J8 decision.
 */
export function lockGoal(
  location: ProjectLocation,
  goalId: string,
  actor: string,
  now: () => Date = () => new Date(),
): GoalApproval {
  if (!actor.startsWith("human:")) throw new ApprovalError(`only a person approves a goal (J1); actor was ${actor}`);
  const ledger = new Ledger(location.dir, now);
  const previous = latestApproval(ledger.readVerified(), goalId);
  const goal = readGoal(location.dir, goalId);
  const metrics = referencedMetrics(goal.front);
  const proposals = metrics.map((id) => {
    const proposal = readProposal(location.dir, id);
    if (proposal === null) throw new ApprovalError(`metric ${id} has no proposal; run omf metric propose ${id}`);
    return proposal;
  });
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
  };
  const check = validate("goal-lock.schema.json", lock);
  if (!check.ok) throw new GoalLockError(`invalid goal lock: ${check.errors}`);
  writePrivateFile(goalLockFile(location.dir, goalId), `${JSON.stringify(lock, null, 2)}\n`);
  const approved = ledger.append({
    actor,
    type: "goal.approved",
    payload: { goal_id: goalId, regime, semantic_sha256, head_commit, metrics },
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
  };
}
