import type { Ledger, LedgerEvent, NewEvent } from "../core/ledger.js";
import { validateDef } from "../core/schema.js";
import type { DecisionScope } from "../decision/types.js";
import { scenarioRef } from "./types.js";
import type { AuthorFailureCode, AuthorStamp, ScenarioStatus, SealFeedback, StoredScenario } from "./types.js";

/**
 * Ledger events of the Scenario Vault (M3c): `seal.*`, `scenario.status_changed` and `gate2.evaluated`. Every payload is
 * codes, counts, digests, decision ids and 16-hex `scenario_ref`s, closed by `additionalProperties: false` in
 * `scenario.schema.json`. A scenario's text, id, canary, argv and stdin can never reach the ledger through here.
 */

const SCHEMA = "scenario.schema.json";

/**
 * The event M3b1 writes when the implementation starts. Referenced by its string, so this module builds on nothing M3b adds
 *; a test in the line integration task checks that it is a member of M3b1's `W_EVENT_TYPES` (src/work/w-events.ts); M3b1 exports no separate constant for it.
 */
export const WORK_STARTED_EVENT = "work.started";

/** `seal-<16 hex>` names the set directory, so two seals of one item never share a path. */
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
 * They are never silently dropped: GATE-2 fails on any. `records` is every valid `seal.completed` in ledger order.
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
  /** The three plain counts a re-seal prompt may carry (`sealFeedbackFor`); null unless the route is `back_to_S2`. */
  feedback_counts: { weak: number; contradictions: number; invalid: number } | null;
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

/** What GATE-2's thin adapter appends; `gate2EventFor` maps a `Gate2Result` onto this input. */
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
    feedback_counts: input.feedback_counts === null ? null : { ...input.feedback_counts },
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

/** Rounds follow completed seals only: a failed seal consumes none. The seal stage recounts this inside `appendWith`. */
export function nextSealRound(events: readonly LedgerEvent[], scope: DecisionScope): number {
  return foldSeals(events, scope).completed + 1;
}

interface StatusPayload {
  seal_id: string;
  scenario_ref: string;
  status: Exclude<ScenarioStatus, "active">;
  reason: StatusReason;
}

/**
 * `scenarioRef -> status` for one set, from `scenario.status_changed` only; absent means `active`. The first valid move of a
 * scenario stands. A later omf move of the same scenario, an invalid omf `scenario.*` event or an unknown `scenario.*` type is
 * an anomaly. Events of other seals, scopes and actors are skipped.
 */
export function foldStatuses(
  events: readonly LedgerEvent[],
  scope: DecisionScope,
  sealId: string,
): { statuses: ReadonlyMap<string, ScenarioStatus>; anomalies: number } {
  const statuses = new Map<string, ScenarioStatus>();
  let anomalies = 0;
  for (const event of events) {
    if (!event.type.startsWith("scenario.")) continue;
    if (event.actor !== "omf" || !inScope(event, scope)) continue;
    if (event.type !== "scenario.status_changed" || !validateDef(SCHEMA, "ev_scenario_status_changed", event.payload).ok) {
      anomalies += 1;
      continue;
    }
    const payload = event.payload as unknown as StatusPayload;
    if (payload.seal_id !== sealId) continue;
    if (statuses.has(payload.scenario_ref)) {
      anomalies += 1;
      continue;
    }
    statuses.set(payload.scenario_ref, payload.status);
  }
  return { statuses, anomalies };
}

export interface EffectiveScenario {
  scenario: StoredScenario;
  status: ScenarioStatus;
}

/** The ledger's status, else `active` (OMF stamps active at intake). No field of the stored file is read for this. */
export function effectiveScenarios(set: readonly StoredScenario[], statuses: ReadonlyMap<string, ScenarioStatus>): EffectiveScenario[] {
  return set.map((scenario) => ({ scenario, status: statuses.get(scenarioRef(scenario.scenario_id)) ?? "active" }));
}

export type AuthorOrder = { ok: true } | { ok: false; reason: "no_seal" | "seal_after_start" };

/**
 * "The author precedes the implementer", from ledger order only. The first `work.started` of the item (any actor: a forged one
 * makes the check fail closed) must come after the latest valid `seal.completed`. An item that has not started is ok here;
 * a missing seal is GATE-2's `seal_missing`, not an order problem.
 */
export function authorPrecedesStart(events: readonly LedgerEvent[], scope: DecisionScope): AuthorOrder {
  const start = events.find((event) => event.type === WORK_STARTED_EVENT && inScope(event, scope));
  if (start === undefined) return { ok: true };
  const { latest } = foldSeals(events, scope);
  if (latest === null) return { ok: false, reason: "no_seal" };
  return latest.seq < start.seq ? { ok: true } : { ok: false, reason: "seal_after_start" };
}

export class ScenarioStatusError extends Error {
  constructor(
    readonly code: "unknown_seal" | "already_moved",
    message: string,
  ) {
    super(message);
    this.name = "ScenarioStatusError";
  }
}

/**
 * Moves a scenario from `active` to `retired` or `contaminated` by appending `scenario.status_changed`. The seal must have a
 * valid `seal.completed` and the scenario must not have moved yet; both are checked under the ledger lock, so two callers
 * cannot both move it. Writes nothing to the vault. M3e's audit calls this on a known canary hit. Messages never name the scenario.
 */
export function markScenarioStatus(
  ledger: Ledger,
  scope: DecisionScope,
  sealId: string,
  scenarioId: string,
  status: Exclude<ScenarioStatus, "active">,
  reason: StatusReason,
): void {
  ledger.appendWith((events) => {
    if (!foldSeals(events, scope).records.some((record) => record.seal_id === sealId)) {
      throw new ScenarioStatusError("unknown_seal", "no seal.completed names that seal for this item");
    }
    if (foldStatuses(events, scope, sealId).statuses.has(scenarioRef(scenarioId))) {
      throw new ScenarioStatusError("already_moved", "the scenario is no longer active");
    }
    return scenarioStatusChangedEvent(scope, { seal_id: sealId, scenario_id: scenarioId, status, reason });
  });
}

/**
 * The feedback the next S2 prompt carries: the latest `gate2.evaluated` of the item with route `back_to_S2` whose seq follows the
 * latest `seal.completed` (every such event counts when no seal has completed), rebuilt from `unlinked_decision_ids` and
 * `feedback_counts`. Like `foldSeals` it reads only actor `omf` events that name the item and pass `ev_gate2_evaluated`.
 * null when there is none. `canary_missing` adds no field: the fixed seal instructions carry that requirement.
 */
export function sealFeedbackFromEvents(events: readonly LedgerEvent[], scope: DecisionScope): SealFeedback | null {
  const after = foldSeals(events, scope).latest?.seq ?? -1;
  let found: SealFeedback | null = null;
  for (const event of events) {
    if (event.type !== "gate2.evaluated" || event.actor !== "omf" || !inScope(event, scope) || event.seq <= after) continue;
    if (!validateDef(SCHEMA, "ev_gate2_evaluated", event.payload).ok) continue;
    const payload = event.payload as unknown as Pick<Gate2EventInput, "route" | "unlinked_decision_ids" | "feedback_counts">;
    if (payload.route !== "back_to_S2" || payload.feedback_counts === null) continue;
    found = {
      unlinked_decision_ids: [...payload.unlinked_decision_ids],
      weak: payload.feedback_counts.weak,
      contradictions: payload.feedback_counts.contradictions,
      invalid: payload.feedback_counts.invalid,
    };
  }
  return found;
}
