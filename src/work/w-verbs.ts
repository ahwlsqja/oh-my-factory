import type { StateStore } from "../adapters/state-markdown.js";
import type { Ledger } from "../core/ledger.js";
import type { LockOwner } from "../core/lock.js";
import type { ProjectLocation } from "../core/paths.js";
import { claimStatus } from "./claim.js";
import { type ItemVerdict, verifyItemAgainstLedger } from "./ledger-verify.js";
import { type Disposition, type OutcomeInput, OutcomeError, dispositionOf } from "./outcome.js";
import type { WorkItem, WorkState } from "./types.js";
import { RUN_ID_PATTERN, type ReasonCode, W_REASON_CODES, type WEvent, wEvent } from "./w-events.js";

/**
 * Everything a W verb needs. `location` is carried so `WRun` and the governance re-read share one context;
 * the verbs themselves find the item through the store and its claim through the item directory.
 */
export interface WContext {
  ledger: Ledger;
  store: StateStore;
  now: () => Date;
  location: ProjectLocation;
}

/**
 * Closed failure codes. `outcome_invalid` covers any caller input outside the closed lists: an outcome
 * that is not a legal combination, a reason code that is not in W_REASON_CODES, a progress marker that is
 * not a station and step. `claim_held`, `governance` and `needs_human` are raised by `beginRun` (Task 7).
 */
export type WErrorCode =
  | "malformed"
  | "wrong_state"
  | "claim_held"
  | "claim_lost"
  | "governance"
  | "outcome_invalid"
  | "needs_human";

/** The message is built from codes and validated ids only: no caller string, file text or audit text (M3b1-D3). */
export class WError extends Error {
  constructor(
    readonly code: WErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WError";
  }
}

export const PROGRESS_STATIONS = ["S1", "S2", "S3", "S4", "S5", "S6", "S7"] as const;
/** Closed; M3b2 extends it by editing this list. The store validates the rendered marker again. */
export const PROGRESS_STEPS = ["entered", "working", "checking", "handed_off"] as const;

const WORK_ID_PATTERN = /^w-[0-9a-f]{12}$/;

function assertWorkId(workId: string): void {
  if (!WORK_ID_PATTERN.test(workId)) throw new WError("malformed", "work id is not well formed");
}

/** A run id outside RUN_ID_PATTERN would put an event in the ledger that `classifyWEvent` calls invalid. */
function assertIds(workId: string, runId: string): void {
  assertWorkId(workId);
  if (!RUN_ID_PATTERN.test(runId)) throw new WError("malformed", "run id is not well formed");
}

/** The store's own error text can quote file content, so it is dropped here. */
function readItem(ctx: WContext, workId: string): WorkItem {
  let item: WorkItem | undefined;
  try {
    item = ctx.store.fetchWorkItemsByIds([workId])[0];
  } catch {
    item = undefined;
  }
  if (item === undefined) throw new WError("malformed", `work item ${workId} cannot be read`);
  return item;
}

/**
 * The claim file must still name this run's owner: same pid, start time and acquired_at. A missing file,
 * an unreadable owner or a claim another run took after ours was reclaimed all give `claim_lost`.
 */
function assertClaim(item: WorkItem, claim: LockOwner): void {
  const owner = claimStatus(item.dir).owner;
  if (
    owner === null ||
    owner.pid !== claim.pid ||
    owner.start_time !== claim.start_time ||
    owner.acquired_at !== claim.acquired_at
  ) {
    throw new WError("claim_lost", `the claim on ${item.front.work_id} is not the one this run holds`);
  }
}

/** A veto or cancel the ledger already holds shows up as `state_mismatch`; every other mismatch is malformed. */
function refuse(workId: string, reason: string): never {
  throw new WError(
    reason === "state_mismatch" ? "wrong_state" : "malformed",
    `work item ${workId} does not match the ledger (${reason})`,
  );
}

function requireOk(workId: string, verdict: ItemVerdict): void {
  if (!verdict.ok) refuse(workId, verdict.reason);
}

function requireState(item: WorkItem, allowed: readonly WorkState[]): void {
  if (!allowed.includes(item.front.state)) {
    throw new WError("wrong_state", `work item ${item.front.work_id} is ${item.front.state}`);
  }
}

/** dispositionOf with its failures turned into a closed code; the reason code is checked against the list first. */
function dispose(input: OutcomeInput): Disposition {
  if (input.reason_code !== null && !W_REASON_CODES.includes(input.reason_code)) {
    throw new WError("outcome_invalid", "the reason code is not in the closed list");
  }
  try {
    return dispositionOf(input);
  } catch (err) {
    if (err instanceof OutcomeError) {
      throw new WError("outcome_invalid", "the outcome, reason code and flags are not a legal combination");
    }
    throw err;
  }
}

const scopeOf = (item: WorkItem, runId: string): { goal_id: string; work_id: string; run_id: string } => ({
  goal_id: item.front.goal_id,
  work_id: item.front.work_id,
  run_id: runId,
});

interface Decision {
  event: WEvent;
  /** The store verb that makes item.md match the event; null for an event-only verb. */
  apply: (() => WorkItem) | null;
}

/** Thrown by `repairItem` inside the ledger lock when the item needs no repair; nothing is written. */
class NothingToRepair extends Error {}

/**
 * The shared shape of every event verb (M3b1-D2). Under the ledger lock it re-reads the item, proves the
 * claim, runs the verifier on the events it holds and lets `decide` choose the event or refuse. Only after
 * the event is on disk does it call the store. A store failure after the append (a veto's file write won
 * the race) leaves a W event the verifier still accepts: the veto closes the item.
 */
function commit(
  ctx: WContext,
  claim: LockOwner,
  workId: string,
  decide: (item: WorkItem, verdict: ItemVerdict) => Decision,
): WorkItem {
  const held: { item?: WorkItem; decision?: Decision } = {};
  ctx.ledger.appendWith((events) => {
    const item = readItem(ctx, workId);
    assertClaim(item, claim);
    const decision = decide(item, verifyItemAgainstLedger(item.front, events));
    held.item = item;
    held.decision = decision;
    return wEvent(decision.event);
  });
  if (held.item === undefined || held.decision === undefined) throw new Error("appendWith returned without a decision");
  return held.decision.apply === null ? held.item : held.decision.apply();
}

/** ready -> in_progress under a valid claim. */
export function startItem(ctx: WContext, claim: LockOwner, workId: string, runId: string): WorkItem {
  assertIds(workId, runId);
  return commit(ctx, claim, workId, (item, verdict) => {
    requireOk(workId, verdict);
    requireState(item, ["ready"]);
    return {
      event: { type: "work.started", payload: { ...scopeOf(item, runId), from: "ready" } },
      apply: () => ctx.store.startWorkItem(workId, ctx.now()),
    };
  });
}

/**
 * in_progress -> awaiting_review. The recommendation comes from `dispositionOf`, never from the caller:
 * a flawed outcome cannot be recommended for merge, and `humanNeeded` is valid only with success (M3-D17).
 * The event carries no reason code (section 4), but the table wants a closed code for every non-success
 * outcome; the real one is chosen by the M3b2 classifier, so a fixed code is passed and never stored.
 */
export function submitForReview(
  ctx: WContext,
  claim: LockOwner,
  workId: string,
  runId: string,
  outcome: "success" | "flawed",
  humanNeeded = false,
): WorkItem {
  assertIds(workId, runId);
  if (outcome !== "success" && outcome !== "flawed") {
    throw new WError("outcome_invalid", "only success and flawed outcomes are submitted");
  }
  const disposition = dispose({
    outcome,
    exhausted: false,
    reason_code: outcome === "success" ? null : "station_error",
    ...(humanNeeded ? { human_needed: true } : {}),
  });
  if (disposition.action !== "submit") throw new WError("outcome_invalid", "this outcome is not a submission");
  const recommendation = disposition.recommendation;
  return commit(ctx, claim, workId, (item, verdict) => {
    requireOk(workId, verdict);
    requireState(item, ["in_progress"]);
    return {
      event: { type: "work.submitted", payload: { ...scopeOf(item, runId), outcome, recommendation } },
      apply: () => ctx.store.submitWorkItemForReview(workId, ctx.now()),
    };
  });
}

/** in_progress -> failed, for the two outcomes the table fails when GATE-4 is exhausted or infrastructure is gone. */
export function failItem(
  ctx: WContext,
  claim: LockOwner,
  workId: string,
  runId: string,
  input: { outcome: "flawed" | "blocked"; reason_code: ReasonCode },
): WorkItem {
  assertIds(workId, runId);
  const disposition = dispose({ outcome: input.outcome, exhausted: true, reason_code: input.reason_code });
  if (disposition.action !== "fail") throw new WError("outcome_invalid", "this outcome does not fail the item");
  return commit(ctx, claim, workId, (item, verdict) => {
    requireOk(workId, verdict);
    requireState(item, ["in_progress"]);
    return {
      event: {
        type: "work.failed",
        payload: { ...scopeOf(item, runId), outcome: input.outcome, reason_code: input.reason_code },
      },
      apply: () => ctx.store.failWorkItem(workId, ctx.now()),
    };
  });
}

/** Event only: the item stays ready (never started) or in_progress, and item.md is not touched (M3b1-D7). */
export function parkItem(
  ctx: WContext,
  claim: LockOwner,
  workId: string,
  runId: string,
  input: { outcome: "blocked" | "manual"; reason_code: ReasonCode },
): WorkItem {
  assertIds(workId, runId);
  const disposition = dispose({ outcome: input.outcome, exhausted: false, reason_code: input.reason_code });
  if (disposition.action !== "park") throw new WError("outcome_invalid", "this outcome does not park the item");
  return commit(ctx, claim, workId, (item, verdict) => {
    requireOk(workId, verdict);
    requireState(item, ["ready", "in_progress"]);
    return {
      event: {
        type: "work.parked",
        payload: { ...scopeOf(item, runId), outcome: input.outcome, reason_code: input.reason_code },
      },
      apply: null,
    };
  });
}

/**
 * Makes item.md catch up with a ledger that is exactly one W edge ahead (a crash between the append and the
 * file write). Returns null when there is nothing to repair. Any other disagreement is refused: a file that
 * is ahead of the ledger, or further behind, is never healed (M3b1-D4).
 */
export function repairItem(ctx: WContext, claim: LockOwner, workId: string, runId: string): WorkItem | null {
  assertIds(workId, runId);
  try {
    return commit(ctx, claim, workId, (item, verdict) => {
      if (verdict.ok) throw new NothingToRepair();
      if (verdict.reason !== "w_repairable") refuse(workId, verdict.reason);
      const to = verdict.repair_to;
      return {
        event: {
          type: "work.repaired",
          payload: { ...scopeOf(item, runId), from: item.front.state, to, source_seq: verdict.source_seq },
        },
        apply: () => ctx.store.repairWorkItem(workId, to, ctx.now()),
      };
    });
  } catch (err) {
    if (err instanceof NothingToRepair) return null;
    throw err;
  }
}

/**
 * Writes the progress marker (`S3 working`) with no ledger event (M3b1-D10). OMF renders the text from two
 * closed lists, so nothing a model or a metric produced can reach item.md; the store checks the grammar again.
 */
export function setItemProgress(
  ctx: WContext,
  claim: LockOwner,
  workId: string,
  progress: { station: (typeof PROGRESS_STATIONS)[number]; step: (typeof PROGRESS_STEPS)[number] },
): WorkItem {
  assertWorkId(workId);
  const { station, step } = progress;
  if (
    !(PROGRESS_STATIONS as readonly string[]).includes(station) ||
    !(PROGRESS_STEPS as readonly string[]).includes(step)
  ) {
    throw new WError("outcome_invalid", "progress is not a station and step from the closed lists");
  }
  const item = readItem(ctx, workId);
  assertClaim(item, claim);
  requireState(item, ["in_progress"]);
  return ctx.store.setProgressMarker(workId, `${station} ${step}`, ctx.now());
}
