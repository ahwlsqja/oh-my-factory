import type { LedgerEvent, NewEvent } from "../core/ledger.js";
import { validateDef } from "../core/schema.js";
import type { DecisionScope } from "../decision/types.js";
import { scenarioRef } from "./types.js";
import type { AuthorFailureCode, AuthorStamp, ScenarioStatus, SealFeedback } from "./types.js";

/**
 * Ledger events of the Scenario Vault (M3c): `seal.*`, `scenario.status_changed` and `gate2.evaluated`. Every payload is
 * codes, counts, digests, decision ids and 16-hex `scenario_ref`s (M3c-D10), closed by `additionalProperties: false` in
 * `scenario.schema.json`. A scenario's text, id, canary, argv and stdin can never reach the ledger through here.
 */

const SCHEMA = "scenario.schema.json";

/**
 * The event M3b1 writes when the implementation starts. Referenced by its string, so this module builds on nothing M3b adds
 * (M3c-D14); a test in the line integration task checks that it is a member of M3b1's `W_EVENT_TYPES` (src/work/w-events.ts); M3b1 exports no separate constant for it.
 */
export const WORK_STARTED_EVENT = "work.started";

/** `seal-<16 hex>` names the set directory, so two seals of one item never share a path (M3c-D1). */
export const SEAL_ID_PATTERN = /^seal-[0-9a-f]{16}$/;

export type SealFailureCode = AuthorFailureCode | "no_valid_scenarios" | "write_failed";
export type StatusReason = "canary_hit" | "exposure_limit" | "person_retired" | "contradiction";

export interface SealCounts {
  authored: number;
  stored: number;
  behavior: number;
  contradiction_canary: number;
  train: number;
  test: number;
  rejected: number;
  ignored_fields: number;
}

/** What `seal.completed` pins: the set by digest, the decisions by digest, the author by stamp. */
export interface SealRecord {
  seq: number;
  round: number;
  seal_id: string;
  author: AuthorStamp;
  decisions_digest: string;
  set_sha256: string;
  counts: SealCounts;
}

/**
 * `anomalies` counts omf-actor `seal.*` events of this item that failed validation, named an unknown type or repeated a seal id.
 * They are never silently dropped (M3c-D20): GATE-2 fails on any. `records` is every valid `seal.completed` in ledger order.
 */
export interface SealFold {
  latest: SealRecord | null;
  completed: number;
  failed: number;
  anomalies: number;
  records: SealRecord[];
}

export interface SealRequestedInput {
  round: number;
  author: Pick<AuthorStamp, "vendor" | "model" | "isolation">;
  input_sha256: string;
  decisions_digest: string;
  feedback: SealFeedback | null;
}
export interface SealCompletedInput {
  round: number;
  seal_id: string;
  author: AuthorStamp;
  decisions_digest: string;
  set_sha256: string;
  counts: SealCounts;
  rejected_by_code: Readonly<Record<string, number>>;
}
export interface SealFailedInput {
  round: number;
  code: SealFailureCode;
  duration_ms: number;
}
/** Takes the scenario id so the caller cannot hand over a ref it made up; only `scenarioRef(id)` is stored. */
export interface ScenarioStatusChangedInput {
  seal_id: string;
  scenario_id: string;
  status: Exclude<ScenarioStatus, "active">;
  reason: StatusReason;
}
export interface Gate2Counts {
  active: number;
  behavior_train: number;
  behavior_test: number;
  canaries: number;
  contaminated: number;
  retired: number;
}
export interface Gate2EventInput {
  round: number;
  seal_id: string | null;
  status: "pass" | "fail";
  route: "J2" | "J3" | "J7" | "back_to_S2" | null;
  reason_codes: readonly string[];
  unlinked_decision_ids: readonly string[];
  not_run_decision_ids: readonly string[];
  counts: Gate2Counts;
  set_sha256: string | null;
  decisions_digest: string;
}

/** Adds the scope, validates against the event's definition and returns an actor-`omf` event. Throws before anything is appended. */
function build(scope: DecisionScope, type: string, def: string, body: Record<string, unknown>): NewEvent {
  const payload = { goal_id: scope.goal_id, work_id: scope.work_id, ...body };
  const checked = validateDef(SCHEMA, def, payload);
  if (!checked.ok) throw new Error(`invalid ${type} payload: ${checked.errors}`);
  return { actor: "omf", type, payload };
}

/** Written before the author runs. Feedback is stored as a count of unlinked decisions, never as their ids. */
export function sealRequestedEvent(scope: DecisionScope, input: SealRequestedInput): NewEvent {
  const { vendor, model, isolation } = input.author;
  const feedback =
    input.feedback === null
      ? null
      : {
          unlinked_decision_count: input.feedback.unlinked_decision_ids.length,
          weak: input.feedback.weak,
          contradictions: input.feedback.contradictions,
          invalid: input.feedback.invalid,
        };
  return build(scope, "seal.requested", "ev_seal_requested", {
    round: input.round,
    author: { vendor, model, isolation },
    input_sha256: input.input_sha256,
    decisions_digest: input.decisions_digest,
    feedback,
  });
}

/** The pin: set digest, decisions digest and author stamp (isolation included, so a host stub author is reported as unmeasured). */
export function sealCompletedEvent(scope: DecisionScope, input: SealCompletedInput): NewEvent {
  const { vendor, model, at, isolation } = input.author;
  return build(scope, "seal.completed", "ev_seal_completed", {
    round: input.round,
    seal_id: input.seal_id,
    author: { vendor, model, at, isolation },
    decisions_digest: input.decisions_digest,
    set_sha256: input.set_sha256,
    counts: { ...input.counts },
    rejected_by_code: { ...input.rejected_by_code },
  });
}

export function sealFailedEvent(scope: DecisionScope, input: SealFailedInput): NewEvent {
  return build(scope, "seal.failed", "ev_seal_failed", { round: input.round, code: input.code, duration_ms: input.duration_ms });
}

export function scenarioStatusChangedEvent(scope: DecisionScope, input: ScenarioStatusChangedInput): NewEvent {
  return build(scope, "scenario.status_changed", "ev_scenario_status_changed", {
    seal_id: input.seal_id,
    scenario_ref: scenarioRef(input.scenario_id),
    status: input.status,
    reason: input.reason,
  });
}

/** What GATE-2's thin adapter appends; `gate2EventFor` (T8) maps a `Gate2Result` onto this input. */
export function gate2EvaluatedEvent(scope: DecisionScope, input: Gate2EventInput): NewEvent {
  return build(scope, "gate2.evaluated", "ev_gate2_evaluated", {
    round: input.round,
    seal_id: input.seal_id,
    status: input.status,
    route: input.route,
    reason_codes: [...input.reason_codes],
    unlinked_decision_ids: [...input.unlinked_decision_ids],
    not_run_decision_ids: [...input.not_run_decision_ids],
    counts: { ...input.counts },
    set_sha256: input.set_sha256,
    decisions_digest: input.decisions_digest,
  });
}

const SEAL_DEFS: ReadonlyMap<string, string> = new Map([
  ["seal.requested", "ev_seal_requested"],
  ["seal.completed", "ev_seal_completed"],
  ["seal.failed", "ev_seal_failed"],
]);

interface CompletedPayload {
  round: number;
  seal_id: string;
  author: AuthorStamp;
  decisions_digest: string;
  set_sha256: string;
  counts: SealCounts;
}

/** True when the event names this goal and work item. An event that does not cannot be attributed to any item. */
function inScope(event: LedgerEvent, scope: DecisionScope): boolean {
  return event.payload["goal_id"] === scope.goal_id && event.payload["work_id"] === scope.work_id;
}

/**
 * Pure fold of the verified ledger into the seals of one work item. Only actor `omf` counts (a `seal.completed` written by a
 * person or an agent is ignored, so it cannot pin a set), and only events that name this scope. An `omf` event that fails its
 * schema, has an unknown `seal.*` type, or repeats a `seal_id` is an anomaly and is not counted.
 */
export function foldSeals(events: readonly LedgerEvent[], scope: DecisionScope): SealFold {
  const records: SealRecord[] = [];
  const seen = new Set<string>();
  let failed = 0;
  let anomalies = 0;
  for (const event of events) {
    if (!event.type.startsWith("seal.")) continue;
    if (event.actor !== "omf" || !inScope(event, scope)) continue;
    const def = SEAL_DEFS.get(event.type);
    if (def === undefined || !validateDef(SCHEMA, def, event.payload).ok) {
      anomalies += 1;
      continue;
    }
    if (event.type === "seal.failed") {
      failed += 1;
      continue;
    }
    if (event.type === "seal.requested") continue;
    const payload = event.payload as unknown as CompletedPayload;
    if (seen.has(payload.seal_id)) {
      anomalies += 1;
      continue;
    }
    seen.add(payload.seal_id);
    records.push({
      seq: event.seq,
      round: payload.round,
      seal_id: payload.seal_id,
      author: {
        vendor: payload.author.vendor,
        model: payload.author.model,
        at: payload.author.at,
        isolation: payload.author.isolation,
      },
      decisions_digest: payload.decisions_digest,
      set_sha256: payload.set_sha256,
      counts: { ...payload.counts },
    });
  }
  return { latest: records.at(-1) ?? null, completed: records.length, failed, anomalies, records };
}

/** Rounds follow completed seals only: a failed seal consumes none. T10 recounts this inside `appendWith`. */
export function nextSealRound(events: readonly LedgerEvent[], scope: DecisionScope): number {
  return foldSeals(events, scope).completed + 1;
}
