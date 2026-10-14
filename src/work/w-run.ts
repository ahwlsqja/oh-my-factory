import { type StateStore, createMarkdownStore, findWorkItem } from "../adapters/state-markdown.js";
import { Ledger, type LedgerEvent } from "../core/ledger.js";
import { LockHeldError, type LockOwner } from "../core/lock.js";
import type { ProjectLocation } from "../core/paths.js";
import { type ClaimStatus, claimItem, claimStatus, releaseItem } from "./claim.js";
import { type Governance, type GovernanceCode, GovernanceError, governanceDrift, readGovernance } from "./governance.js";
import { verifiedItems, verifyItemAgainstLedger } from "./ledger-verify.js";
import { type Disposition, type OutcomeInput, OutcomeError, dispositionOf } from "./outcome.js";
import type { WorkItem, WorkState } from "./types.js";
import { type ReasonCode, lastStateEvent, newRunId, wEvent } from "./w-events.js";
import { type WContext, WError, failItem, parkItem, repairItem, setItemProgress, startItem, submitForReview } from "./w-verbs.js";

export interface BeginRunOptions {
  location: ProjectLocation;
  workId: string;
  now?: () => Date;
  newRunId?: (now: Date) => string;
  store?: StateStore;
}

export type RecheckFailure = "vetoed" | "cancelled" | "state_changed" | "malformed" | "claim_lost" | "governance";

/** Closed codes only: nothing a model wrote and nothing from the audit reaches a caller through these (M3b1-D3). */
export type Recheck = { ok: true; item: WorkItem } | { ok: false; reason: RecheckFailure; code: GovernanceCode | null };

export type FinishResult =
  | { applied: true; disposition: Disposition; item: WorkItem }
  | { applied: false; reason: RecheckFailure; code: GovernanceCode | null };

export type RunProgress = Parameters<typeof setItemProgress>[3];

export interface WRun {
  readonly runId: string;
  readonly workId: string;
  readonly goalId: string;
  /** True when the item was already in_progress at entry (a killed earlier run, or one parked after it started). */
  readonly resumed: boolean;
  /** Set when a stale or unreadable claim was taken over (pid null when the owner was unreadable). */
  readonly reclaimed: { pid: number | null } | null;
  /** Ids of the goal's repairable items that this entry healed. */
  readonly repaired: readonly string[];
  /** S3 entry: moves a ready item to in_progress. Idempotent. `beginRun` never starts an item (M3b1-D11). */
  start(): void;
  /**
   * Call before every station. In order: the claim file still names this run, the ledger does not hold a
   * veto or cancel (also in the window before item.md is rewritten), the item verifies and is in the state
   * this run last left it, and config and regime are as they were at entry (rule 5).
   * `governance` carries a closed code when the re-read failed, and null when it only drifted.
   */
  recheck(): Recheck;
  progress(progress: RunProgress): void;
  /** Re-checks, applies the table row through the verbs, then releases the claim iff it is still ours. */
  finish(input: OutcomeInput): FinishResult;
  /** Releases the claim iff the claim file still names this run. Never removes a foreign claim. Idempotent. */
  abandon(): void;
}

const HUMAN = /^human:\S+$/;

function sameOwner(found: LockOwner | null, mine: LockOwner): boolean {
  return found !== null && found.pid === mine.pid && found.start_time === mine.start_time && found.acquired_at === mine.acquired_at;
}

/**
 * Releases only a claim that still names this run (M3b1-D13). `releaseLock` already refuses another pid,
 * but a claim file replaced by a live process with our pid reused is not ours either; forcing its removal
 * would break mutual exclusion, so a foreign claim is left alone.
 */
function releaseOwn(itemDir: string, mine: LockOwner): void {
  if (sameOwner(claimStatus(itemDir).owner, mine)) releaseItem(itemDir);
}

function readItem(location: ProjectLocation, workId: string): WorkItem {
  try {
    const item = findWorkItem(location.dir, workId);
    if (item !== null) return item;
  } catch {
    // an unreadable item.md is a malformed item; the message below carries the id only
  }
  throw new WError("malformed", `work item ${workId} is malformed or unknown`);
}

function governanceOf(location: ProjectLocation, goalId: string, at: Date): Governance {
  try {
    return readGovernance(location, goalId, at);
  } catch (err) {
    if (err instanceof GovernanceError) throw new WError("governance", err.message);
    throw err;
  }
}

/** Same actor rules as the verifier: a veto counts only from a person; a cancel from a person or OMF. */
function stoppedBy(events: readonly LedgerEvent[], goalId: string, workId: string): "vetoed" | "cancelled" | null {
  for (const event of events) {
    if (event.payload.goal_id !== goalId || event.payload.work_id !== workId) continue;
    if (event.type === "work.vetoed" && HUMAN.test(event.actor)) return "vetoed";
    if (event.type === "work.cancelled" && (event.actor === "omf" || HUMAN.test(event.actor))) return "cancelled";
  }
  return null;
}

/** previous_acquired_at is a timestamp or the empty string; a claim file with anything else records "". */
function timestampOrEmpty(value: string): string {
  return Number.isNaN(Date.parse(value)) ? "" : value;
}

/**
 * Leaves the trace of a killed run (M3b1-D8): a dead process cannot append, so the next run does. Written
 * right after the claim is taken, so a refusal further on (wrong_state, needs_human) still leaves it.
 */
function recordReclaim(
  ledger: Ledger,
  scope: { goal_id: string; work_id: string; run_id: string },
  before: ClaimStatus,
): { pid: number | null } | null {
  if (!before.stale && !(before.held && before.owner === null)) return null;
  const pid = before.owner?.pid ?? null;
  ledger.append(
    wEvent({
      type: "work.claim_reclaimed",
      payload: { ...scope, previous_pid: pid, previous_acquired_at: timestampOrEmpty(before.owner?.acquired_at ?? "") },
    }),
  );
  return { pid };
}

function requireReason(input: OutcomeInput): ReasonCode {
  if (input.reason_code === null) throw new WError("outcome_invalid", "the outcome has no reason code");
  return input.reason_code;
}

/**
 * Heals every repairable item of the goal, each under its own claim (M3b1-D5). An item under a live claim
 * is somebody's run and is skipped. Every W entry calls this first, so a crash between a ledger append and
 * its file write is repaired by the next run of any item, without anyone naming the stuck one.
 */
export function repairGoal(ctx: WContext, goalId: string): string[] {
  const { repairable } = verifiedItems(ctx.store, ctx.ledger.readVerified(), goalId);
  const healed: string[] = [];
  for (const entry of repairable) {
    const before = claimStatus(entry.dir);
    if (before.held) continue;
    let claim: LockOwner;
    try {
      claim = claimItem(entry.dir);
    } catch (err) {
      if (err instanceof LockHeldError) continue;
      throw err;
    }
    try {
      const runId = newRunId(ctx.now());
      recordReclaim(ctx.ledger, { goal_id: goalId, work_id: entry.work_id, run_id: runId }, before);
      if (repairItem(ctx, claim, entry.work_id, runId) !== null) healed.push(entry.work_id);
    } finally {
      releaseOwn(entry.dir, claim);
    }
  }
  return healed;
}

/**
 * Enters one work item: governance, sweep, claim, then the entry checks. Order matters (M3b1 design 3.8):
 * rule 5 first, so a stopped goal never touches a claim; the sweep before the claim, so this item's own
 * repair runs under a claim of its own; every failure after the claim releases it.
 */
export function beginRun(options: BeginRunOptions): WRun {
  const now = options.now ?? ((): Date => new Date());
  const mint = options.newRunId ?? newRunId;
  const { location, workId } = options;
  const ctx: WContext = {
    ledger: new Ledger(location.dir, now),
    store: options.store ?? createMarkdownStore(location.dir),
    now,
    location,
  };

  const found = readItem(location, workId);
  const goalId = found.front.goal_id;
  const itemDir = found.dir;
  const baseline = governanceOf(location, goalId, now());
  const repaired = repairGoal(ctx, goalId);
  const runId = mint(now());
  const scope = { goal_id: goalId, work_id: workId, run_id: runId };

  const before = claimStatus(itemDir);
  if (before.held && before.owner !== null) throw new WError("claim_held", `work item ${workId} is claimed by a run`);
  let owner: LockOwner;
  try {
    owner = claimItem(itemDir);
  } catch (err) {
    if (err instanceof LockHeldError) throw new WError("claim_held", `work item ${workId} is claimed by a run`);
    throw err;
  }

  let reclaimed: { pid: number | null } | null = null;
  let resumed = false;
  let expected: WorkState = "ready";
  try {
    reclaimed = recordReclaim(ctx.ledger, scope, before);
    const events = ctx.ledger.readVerified();
    const item = readItem(location, workId); // after the sweep: it may just have been repaired
    const verdict = verifyItemAgainstLedger(item.front, events);
    if (!verdict.ok) throw new WError("malformed", `work item ${workId} is malformed (${verdict.reason})`);
    if (item.front.state !== "ready" && item.front.state !== "in_progress") {
      throw new WError("wrong_state", `work item ${workId} is ${item.front.state}`);
    }
    // spec §5.6: a manual park is a trust boundary a person must cross; the event that clears it is a later milestone (D7)
    const last = lastStateEvent(events, workId);
    if (last !== null && last.event.type === "work.parked" && last.event.payload.outcome === "manual") {
      throw new WError("needs_human", `work item ${workId} is parked for a person`);
    }
    if (item.front.state === "in_progress") {
      ctx.ledger.append(wEvent({ type: "work.resumed", payload: scope }));
      resumed = true;
    }
    expected = item.front.state;
  } catch (err) {
    releaseOwn(itemDir, owner);
    throw err;
  }

  function start(): void {
    if (readItem(location, workId).front.state === "in_progress") return;
    startItem(ctx, owner, workId, runId);
    expected = "in_progress";
  }

  function recheck(): Recheck {
    const miss = (reason: RecheckFailure, code: GovernanceCode | null = null): Recheck => ({ ok: false, reason, code });
    if (!sameOwner(claimStatus(itemDir).owner, owner)) return miss("claim_lost");
    let events: LedgerEvent[];
    try {
      events = ctx.ledger.readVerified();
    } catch {
      return miss("governance", "ledger_corrupt");
    }
    const stopped = stoppedBy(events, goalId, workId);
    if (stopped !== null) return miss(stopped);
    let item: WorkItem;
    try {
      item = readItem(location, workId);
    } catch {
      return miss("malformed");
    }
    if (!verifyItemAgainstLedger(item.front, events).ok) return miss("malformed");
    if (item.front.state !== expected) return miss("state_changed");
    try {
      if (governanceDrift(baseline, readGovernance(location, goalId, now())) !== null) return miss("governance");
    } catch (err) {
      if (err instanceof GovernanceError) return miss("governance", err.problems[0] ?? null);
      throw err;
    }
    return { ok: true, item };
  }

  function finish(input: OutcomeInput): FinishResult {
    try {
      let disposition: Disposition;
      try {
        disposition = dispositionOf(input);
      } catch (err) {
        if (err instanceof OutcomeError) throw new WError("outcome_invalid", "the outcome is not a row of the outcome table");
        throw err;
      }
      const checked = recheck();
      if (!checked.ok) return { applied: false, reason: checked.reason, code: checked.code };
      if (disposition.action === "park") {
        const outcome = input.outcome === "manual" ? "manual" : "blocked";
        const item = parkItem(ctx, owner, workId, runId, { outcome, reason_code: requireReason(input) });
        return { applied: true, disposition, item };
      }
      start(); // a submit or fail on a still-ready item starts it first; on an in_progress item it does nothing
      if (disposition.action === "submit") {
        const outcome = input.outcome === "success" ? "success" : "flawed";
        const item = submitForReview(ctx, owner, workId, runId, outcome, input.human_needed === true);
        return { applied: true, disposition, item };
      }
      const outcome = input.outcome === "flawed" ? "flawed" : "blocked";
      const item = failItem(ctx, owner, workId, runId, { outcome, reason_code: requireReason(input) });
      return { applied: true, disposition, item };
    } finally {
      releaseOwn(itemDir, owner);
    }
  }

  return {
    runId,
    workId,
    goalId,
    resumed,
    reclaimed,
    repaired,
    start,
    recheck,
    progress: (progress: RunProgress): void => {
      setItemProgress(ctx, owner, workId, progress);
    },
    finish,
    abandon: (): void => {
      releaseOwn(itemDir, owner);
    },
  };
}
