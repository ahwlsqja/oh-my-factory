import { findWorkItem } from "../adapters/state-markdown.js";
import { Ledger, type LedgerEvent, type NewEvent } from "../core/ledger.js";
import type { LockOwner } from "../core/lock.js";
import type { ProjectLocation } from "../core/paths.js";
import { validate } from "../core/schema.js";
import { claimStatus } from "./claim.js";
import { verifyItemAgainstLedger } from "./ledger-verify.js";
import type { WorkItem } from "./types.js";
import { classifyWEvent } from "./w-events.js";
import type { PROGRESS_STATIONS } from "./w-verbs.js";

/**
 * The per-item budget of a W run, kept in the ledger (M3b2-D1, spec §5.0 GATE-4). A limit is copied from
 * config `[w]` at the item's first run, raised only by a person (J8), and consumed by `work.round` and
 * `work.spend` events that OMF appends under the run's claim. Because the counts are folded from the
 * ledger, a restart or a kill cannot reset them (the M2b `budget.consumed` pattern).
 */

/** The four event types of this file; schemas/work-budget-event.schema.json holds their payloads. */
export const WORK_BUDGET_EVENT_TYPES = ["work.limits_set", "work.limit_raised", "work.round", "work.spend"] as const;
export type WorkBudgetEventType = (typeof WORK_BUDGET_EVENT_TYPES)[number];

export type LimitKind = "rounds" | "model_micro_usd";
export const LIMIT_KINDS: readonly LimitKind[] = ["rounds", "model_micro_usd"];

export interface WorkLimits {
  max_rounds: number;
  max_model_micro_usd: number;
}

/**
 * Dollars to whole micro-dollars (M3b2-D2). Floats drift when summed, so the ledger stores integers and the
 * config's dollars are converted once, here. Refuses anything that is not a positive finite amount whose
 * result is a safe integer of at least 1.
 */
export function microUsd(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) throw new RangeError("usd must be a positive finite number");
  const micro = Math.round(usd * 1e6);
  if (micro < 1 || !Number.isSafeInteger(micro)) throw new RangeError("usd is outside the range of whole micro-dollars");
  return micro;
}

const SCHEMA = "work-budget-event.schema.json";
const TYPE_SET: ReadonlySet<string> = new Set(WORK_BUDGET_EVENT_TYPES);
const HUMAN = /^human:\S+$/;
const saturate = (n: number): number => Math.min(n, Number.MAX_SAFE_INTEGER);

/** Why an event was not counted. Closed codes: an anomaly never carries the rejected payload. */
export type BudgetAnomalyCode =
  | "invalid_event" // the payload fails the schema
  | "not_omf" // limits, round or spend written by someone other than omf
  | "not_human" // a raise written by someone other than a person
  | "limits_twice" // the first work.limits_set wins
  | "raise_before_limits"
  | "round_gap"; // a work.round whose number is not rounds_started + 1
export interface BudgetAnomaly {
  code: BudgetAnomalyCode;
  seq: number;
}

export interface WorkBudgetState {
  /** From work.limits_set; null = never recorded. */
  limits: WorkLimits | null;
  /** Sum of the raises a person recorded. */
  raised: { rounds: number; model_micro_usd: number };
  /** limits + raised; null while limits is null. */
  effective: WorkLimits | null;
  /** Count of valid work.round events. */
  rounds_started: number;
  /** prev_signature of the latest valid work.round. */
  previous_signature: string | null;
  /** A null micro_usd counts as unknown and adds nothing. */
  spend: { micro_usd: number; unknown_count: number };
  /** Any anomaly fails GATE-4 closed (Task 3). The offending event counts for nothing. */
  anomalies: BudgetAnomaly[];
}

/**
 * Folds the verified events of one work item into its budget (M3b2-D1 to D3). Pure. Events of other items
 * and every non-budget type are skipped. An invalid event whose `work_id` is missing or malformed names no
 * item, so no item's fold sees it; one that names this item is an `invalid_event` anomaly. Sums saturate at
 * the largest safe integer, so an absurd amount still reads as "over the limit" instead of wrapping.
 */
export function foldWorkBudget(events: readonly LedgerEvent[], workId: string): WorkBudgetState {
  let limits: WorkLimits | null = null;
  const raised = { rounds: 0, model_micro_usd: 0 };
  let roundsStarted = 0;
  let previous: string | null = null;
  const spend = { micro_usd: 0, unknown_count: 0 };
  const anomalies: BudgetAnomaly[] = [];
  const flag = (code: BudgetAnomalyCode, seq: number): void => {
    anomalies.push({ code, seq });
  };

  for (const event of events) {
    if (!TYPE_SET.has(event.type) || event.payload.work_id !== workId) continue;
    if (!validate(SCHEMA, { type: event.type, payload: event.payload }).ok) {
      flag("invalid_event", event.seq);
      continue;
    }
    const payload = event.payload;
    if (event.type === "work.limit_raised") {
      if (!HUMAN.test(event.actor)) flag("not_human", event.seq);
      else if (limits === null) flag("raise_before_limits", event.seq);
      else {
        const { kind, amount } = payload as { kind: LimitKind; amount: number };
        raised[kind] = saturate(raised[kind] + amount);
      }
      continue;
    }
    if (event.actor !== "omf") {
      flag("not_omf", event.seq);
      continue;
    }
    if (event.type === "work.limits_set") {
      if (limits !== null) flag("limits_twice", event.seq);
      else {
        const set = payload as unknown as WorkLimits;
        limits = { max_rounds: set.max_rounds, max_model_micro_usd: set.max_model_micro_usd };
      }
    } else if (event.type === "work.round") {
      const { round, prev_signature } = payload as { round: number; prev_signature: string | null };
      if (round !== roundsStarted + 1) flag("round_gap", event.seq);
      else {
        roundsStarted = round;
        previous = prev_signature;
      }
    } else {
      const { micro_usd } = payload as { micro_usd: number | null };
      if (micro_usd === null) spend.unknown_count += 1;
      else spend.micro_usd = saturate(spend.micro_usd + micro_usd);
    }
  }

  const effective: WorkLimits | null =
    limits === null
      ? null
      : {
          max_rounds: saturate(limits.max_rounds + raised.rounds),
          max_model_micro_usd: saturate(limits.max_model_micro_usd + raised.model_micro_usd),
        };
  return { limits, raised, effective, rounds_started: roundsStarted, previous_signature: previous, spend, anomalies };
}

export type WorkBudgetErrorCode = "forbidden" | "invalid_amount" | "wrong_state" | "no_limits" | "malformed" | "claim_lost";

/** Messages are built from codes and validated ids only: nothing a model, a file or the audit wrote (M3b1-D3). */
export class WorkBudgetError extends Error {
  constructor(
    readonly code: WorkBudgetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkBudgetError";
  }
}

/** The claim a run proved at entry. Every append below re-checks it under the ledger lock. */
export interface OwnedAppend {
  ledger: Ledger;
  itemDir: string;
  claim: LockOwner;
  scope: { goal_id: string; work_id: string; run_id: string };
}

/** Same stations as the W progress marker; `StationId` in line-types.ts (Task 3) is the same type. */
export type BudgetStation = (typeof PROGRESS_STATIONS)[number];

/** Validates at the writer, like `wEvent`: a malformed id or amount fails here and never reaches the ledger. */
function budgetEvent(actor: string, type: WorkBudgetEventType, payload: Record<string, unknown>): NewEvent {
  const check = validate(SCHEMA, { type, payload });
  if (!check.ok) throw new Error(`invalid ${type} event: ${check.errors}`);
  return { actor, type, payload };
}

/** The claim file must still name this run: same pid, start time and acquired_at. Anything else is `claim_lost`. */
function assertOwned(own: OwnedAppend): void {
  const owner = claimStatus(own.itemDir).owner;
  if (
    owner === null ||
    owner.pid !== own.claim.pid ||
    owner.start_time !== own.claim.start_time ||
    owner.acquired_at !== own.claim.acquired_at
  ) {
    throw new WorkBudgetError("claim_lost", `the claim on ${own.scope.work_id} is not the one this run holds`);
  }
}

/** Thrown inside the ledger lock when there is nothing to append; nothing is written. */
class AlreadyRecorded extends Error {}

/**
 * Copies the `[w]` limits into the ledger at the item's first run (M3b2-D1). Idempotent: returns null when
 * limits are already recorded. The claim is proved first, so a run that lost its claim writes nothing.
 */
export function recordLimits(own: OwnedAppend, limits: WorkLimits): LedgerEvent | null {
  try {
    return own.ledger.appendWith((events) => {
      assertOwned(own);
      if (foldWorkBudget(events, own.scope.work_id).limits !== null) throw new AlreadyRecorded();
      return budgetEvent("omf", "work.limits_set", {
        ...own.scope,
        max_rounds: limits.max_rounds,
        max_model_micro_usd: limits.max_model_micro_usd,
      });
    });
  } catch (err) {
    if (err instanceof AlreadyRecorded) return null;
    throw err;
  }
}

/**
 * Consumes one round when S3 opens (M3b2-D3): the number is `rounds_started + 1` from the ledger the lock
 * holds, so two writers cannot take the same number. `prevSignature` is the signature of the round before.
 */
export function recordRound(own: OwnedAppend, prevSignature: string | null): LedgerEvent {
  return own.ledger.appendWith((events) => {
    assertOwned(own);
    const round = foldWorkBudget(events, own.scope.work_id).rounds_started + 1;
    return budgetEvent("omf", "work.round", { ...own.scope, round, prev_signature: prevSignature });
  });
}

/** One station call's model spend in micro-USD; null = the vendor did not say (M3b2-D2). */
export function recordSpend(own: OwnedAppend, station: BudgetStation, micro: number | null): LedgerEvent {
  return own.ledger.appendWith(() => {
    assertOwned(own);
    return budgetEvent("omf", "work.spend", { ...own.scope, station, micro_usd: micro });
  });
}

export const REENTRY_SAME_REASON_MAX = 3;
export const REENTRY_KILLS_MAX = 3;

/** The guard's own stops: counting them would make a stopped item stop itself again for the same reason. */
const NOT_COUNTED: ReadonlySet<string> = new Set(["reentry_loop", "budget_exhausted"]);

/**
 * Re-entry facts since the last human act on the goal (M3b2-D17): an event whose actor is `human:*` and whose
 * payload names this goal. `same_reason` is the largest number of `work.parked` events of this item with one
 * reason code; `kills` is the number of `work.claim_reclaimed` events of this item. Only schema-valid events
 * written by `omf` count (`classifyWEvent`), so a forged park or reclaim cannot push an item into a loop stop.
 */
export function foldReentry(
  events: readonly LedgerEvent[],
  goalId: string,
  workId: string,
): { same_reason: number; kills: number } {
  let since = 0;
  events.forEach((event, index) => {
    if (HUMAN.test(event.actor) && event.payload.goal_id === goalId) since = index + 1;
  });
  const parks = new Map<string, number>();
  let kills = 0;
  for (const event of events.slice(since)) {
    const classified = classifyWEvent(event);
    if (classified.kind !== "w") continue;
    const w = classified.event;
    if (w.payload.work_id !== workId) continue;
    if (w.type === "work.claim_reclaimed") kills += 1;
    else if (w.type === "work.parked") {
      const code: string = w.payload.reason_code;
      if (!NOT_COUNTED.has(code)) parks.set(code, (parks.get(code) ?? 0) + 1);
    }
  }
  return { same_reason: Math.max(0, ...parks.values()), kills };
}

const WORK_ID = /^w-[0-9a-f]{12}$/;

/**
 * The read-only precondition of a raise, shared by the prompt (`workLimitLines`) and the write so that what
 * a person is shown is what the write enforces. The item must read, verify against the ledger and be `ready`
 * or `in_progress`, and its limits must already be recorded (they are copied from `[w]` at the first run).
 */
export function openItemBudget(
  location: ProjectLocation,
  workId: string,
  events: readonly LedgerEvent[],
): { item: WorkItem; state: WorkBudgetState } {
  if (!WORK_ID.test(workId)) throw new WorkBudgetError("malformed", "work id is not well formed");
  let item: WorkItem | null = null;
  try {
    item = findWorkItem(location.dir, workId);
  } catch {
    item = null; // the store's own text can quote file content, so it is dropped
  }
  if (item === null) throw new WorkBudgetError("malformed", `work item ${workId} cannot be read`);
  if (!verifyItemAgainstLedger(item.front, events).ok) {
    throw new WorkBudgetError("malformed", `work item ${workId} does not match the ledger`);
  }
  if (item.front.state !== "ready" && item.front.state !== "in_progress") {
    throw new WorkBudgetError("wrong_state", `work item ${workId} is ${item.front.state}`);
  }
  const state = foldWorkBudget(events, workId);
  if (state.limits === null) {
    throw new WorkBudgetError("no_limits", `work item ${workId} has no recorded limits yet; they are recorded when its first run starts`);
  }
  return { item, state };
}

/**
 * J8: a person raises one limit of an open item (M3b2-D1). The actor must be `human:*`; the item is
 * re-checked under the ledger lock, so a run that finishes or a veto that lands in between cannot be missed.
 * It needs no claim: a person's raise must work while a run holds the item, and the run folds the ledger at its
 * next S3 entry. It moves no state; a person then runs the line again.
 */
export function raiseWorkLimit(
  location: ProjectLocation,
  workId: string,
  kind: LimitKind,
  amount: number,
  actor: string,
): LedgerEvent {
  if (!HUMAN.test(actor)) throw new WorkBudgetError("forbidden", "only a person may raise a work limit (J8)");
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw new WorkBudgetError("invalid_amount", "amount must be a positive whole number");
  }
  return new Ledger(location.dir).appendWith((events) => {
    const { item } = openItemBudget(location, workId, events);
    return budgetEvent(actor, "work.limit_raised", { goal_id: item.front.goal_id, work_id: workId, kind, amount });
  });
}
