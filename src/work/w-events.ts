import { randomBytes } from "node:crypto";
import type { LedgerEvent, NewEvent } from "../core/ledger.js";
import { validate } from "../core/schema.js";
import type { WorkState } from "./types.js";

/**
 * Ledger events of the W loop (spec §5.0, §4.4 step 5). The ledger is the authority for a work item's W state:
 * the store file only catches up to it. Every payload is ids, timestamps and members of a closed
 * list, so the event stream stays safe for the E2 scans (nothing a model wrote, no metric text).
 */

export const W_EVENT_TYPES = [
  "work.started",
  "work.submitted",
  "work.failed",
  "work.parked",
  "work.repaired",
  "work.claim_reclaimed",
  "work.resumed",
] as const;
export type WEventType = (typeof W_EVENT_TYPES)[number];

/** `r-20261014T091500Z-ab12`: UTC second plus four random hex digits, like tick ids. */
export const RUN_ID_PATTERN = /^r-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{4}$/;

const GOAL_ID_PATTERN = /^g-[a-z0-9]+(-[a-z0-9]+)*$/;
const WORK_ID_PATTERN = /^w-[0-9a-f]{12}$/;

export function newRunId(at: Date, hex4: () => string = () => randomBytes(2).toString("hex")): string {
  const stamp = at
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
  const id = `r-${stamp}-${hex4()}`;
  if (!RUN_ID_PATTERN.test(id)) throw new Error("newRunId needs a UTC date and four lowercase hex digits");
  return id;
}

/**
 * Closed list of reasons a run parks or fails an item (mirrored as an enum in work-event.schema.json; a test
 * compares the two). A free-text reason could carry a metric name into the ledger, so none exists. The line sequencer adds
 * codes by editing this list and the schema together.
 */
export const W_REASON_CODES = [
  "j2_open",
  "gate_blocked",
  "budget_exhausted",
  "infra_failure",
  "manual_required",
  "station_error",
  // Added for the line sequencer, GATE-4 and the outcome classifier. The schema enum gets the same twelve.
  "visit_cap",
  "stalled",
  "gate_not_run",
  "station_skipped",
  "evidence_incomplete",
  "run_killed",
  "audit_flag",
  "sealed_failed",
  "flaky_scenario",
  "within_variance",
  "gate2_exhausted",
  "reentry_loop",
  // Added by the real GATE-2: the sealed scenarios, or what they were written from, need a person.
  "scenarios_need_review",
  // The test split and the feedback channel. All four need a person (or a forced downgrade), so none counts as a retryable failure.
  "test_run_incomplete",
  "test_reseal_required",
  "noise_unverified",
  "scenarios_exhausted",
  // The declared gates failed (a RED gate line): a result about the candidate, reviewed at J4.
  "gates_failed",
  // Feedback needs a disclosure budget that is not declared or is used up: a person declares or raises it (J8).
  "disclosure_unavailable",
  // The implementer: its first commit was not the plan alone (a flawed, reviewable result), or it stopped to ask a person
  // to settle a conflict between a test and the spec (blocked, answered at J2, and the item can be run again).
  "plan_missing",
  "implementer_request",
] as const;
export type ReasonCode = (typeof W_REASON_CODES)[number];

export type Recommendation = "merge_recommended" | "not_recommended" | "human_needed";

interface Scope {
  goal_id: string;
  work_id: string;
  run_id: string;
}

export type WEvent =
  | { type: "work.started"; payload: Scope & { from: "ready" } }
  | { type: "work.submitted"; payload: Scope & { outcome: "success" | "flawed"; recommendation: Recommendation } }
  | { type: "work.failed"; payload: Scope & { outcome: "flawed" | "blocked"; reason_code: ReasonCode } }
  | { type: "work.parked"; payload: Scope & { outcome: "blocked" | "manual"; reason_code: ReasonCode } }
  | { type: "work.repaired"; payload: Scope & { from: WorkState; to: WorkState; source_seq: number } }
  // pid null and an empty timestamp mean the previous owner's claim file could not be read.
  | { type: "work.claim_reclaimed"; payload: Scope & { previous_pid: number | null; previous_acquired_at: string } }
  // A new run took over an in_progress item; no state change.
  | { type: "work.resumed"; payload: Scope };

const TARGETS: Readonly<Record<WEventType, WorkState | null>> = {
  "work.started": "in_progress",
  "work.submitted": "awaiting_review",
  "work.failed": "failed",
  "work.parked": null,
  "work.repaired": null,
  "work.claim_reclaimed": null,
  "work.resumed": null,
};

/** The state the event moves the item to; null for the events that move nothing (parked, repaired, reclaimed, resumed). */
export function targetOf(type: WEventType): WorkState | null {
  return TARGETS[type];
}

/**
 * The event as OMF appends it (actor `omf`). The payload is checked against the schema first, so a malformed
 * id fails here, at the writer, instead of becoming a ledger event the verifier has to distrust.
 */
export function wEvent(event: WEvent): NewEvent {
  const payload: Record<string, unknown> = { ...event.payload };
  const check = validate("work-event.schema.json", { type: event.type, payload });
  if (!check.ok) throw new Error(`invalid ${event.type} event: ${check.errors}`);
  return { actor: "omf", type: event.type, payload };
}

export type Classified =
  | { kind: "none" }
  | { kind: "invalid"; goal_id: string | null; work_id: string | null }
  | { kind: "w"; seq: number; event: WEvent };

const W_TYPE_SET: ReadonlySet<string> = new Set(W_EVENT_TYPES);

function idOrNull(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

/**
 * Reads one ledger event as a W event. Only actor `omf` counts: a `work.started` written by `human:*` or
 * `agent:*` is `none`, so a forged event never satisfies the verifier. An `omf` event of a W type whose
 * payload fails the schema is `invalid`; it names the goal and item only when those ids are well formed.
 */
export function classifyWEvent(event: LedgerEvent): Classified {
  if (!W_TYPE_SET.has(event.type) || event.actor !== "omf") return { kind: "none" };
  const check = validate("work-event.schema.json", { type: event.type, payload: event.payload });
  if (!check.ok) {
    return {
      kind: "invalid",
      goal_id: idOrNull(event.payload.goal_id, GOAL_ID_PATTERN),
      work_id: idOrNull(event.payload.work_id, WORK_ID_PATTERN),
    };
  }
  return { kind: "w", seq: event.seq, event: { type: event.type, payload: event.payload } as unknown as WEvent };
}

const STATE_BEARING: ReadonlySet<string> = new Set(["work.started", "work.submitted", "work.failed", "work.parked"]);

/** The last started, submitted, failed or parked event of the item, or null. Repaired, reclaimed and resumed say nothing about state. */
export function lastStateEvent(
  events: readonly LedgerEvent[],
  workId: string,
): Extract<Classified, { kind: "w" }> | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event === undefined) continue;
    const classified = classifyWEvent(event);
    if (classified.kind !== "w" || !STATE_BEARING.has(classified.event.type)) continue;
    if (classified.event.payload.work_id === workId) return classified;
  }
  return null;
}
