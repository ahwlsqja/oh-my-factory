import { canonicalize, sha256Hex } from "../core/canonical-json.js";
import type { LedgerEvent } from "../core/ledger.js";
import { validateDef } from "../core/schema.js";
import { INTERFACE_DECISION_ID } from "./types.js";
import type {
  Anomaly,
  AnomalyCode,
  DecisionClass,
  DecisionRecord,
  DecisionScope,
  DecisionState,
  Deferral,
  InterfaceContract,
  Qas,
  Resolution,
  ResponseMeasure,
} from "./types.js";

const SCHEMA = "decision.schema.json";

/** Ledger event type -> the definition in decision.schema.json that validates its payload. */
const PAYLOAD_DEF: ReadonlyMap<string, string> = new Map([
  ["decision.added", "ev_added"],
  ["decision.resolved", "ev_resolved"],
  ["decision.deferred", "ev_deferred"],
  ["decision.marked_na", "ev_marked_na"],
  ["decision.rejected", "ev_rejected"],
]);

/** Payload shapes after schema validation; the optional fields are absent, never null. */
interface AddedPayload {
  decision_id: string;
  class: DecisionClass;
  question: string;
  qas?: Qas;
  response_measure?: ResponseMeasure;
}
interface ResolvedPayload {
  decision_id: string;
  resolution: Resolution;
  response_measure?: ResponseMeasure;
  interface?: InterfaceContract;
}
interface DeferredPayload {
  decision_id: string;
  deferral: Deferral;
}
interface MarkedNaPayload {
  decision_id: string;
  rationale: string;
  by: string;
  at: string;
}

const isHuman = (actor: string): boolean => /^human:\S+$/.test(actor);

/** Closing event type -> the anomaly raised when its actor is not a person. */
const NOT_HUMAN_CODE: ReadonlyMap<string, AnomalyCode> = new Map([
  ["decision.resolved", "resolution_not_human"],
  ["decision.deferred", "deferral_unsigned"],
  ["decision.marked_na", "na_not_human"],
]);

/** The records returned by the fold must not alias the ledger events they came from. */
const detach = <T>(value: T): T => structuredClone(value);

/**
 * Pure fold of the verified ledger into the decisions of one work item.
 *
 * Only `decision.*` events whose payload names this goal and work item count; the rest are skipped
 * without a trace (an event that does not name the scope cannot be attributed to any item). Each
 * payload is validated against its definition in decision.schema.json: an invalid one is an anomaly
 * (`malformed_event`) and is ignored.
 *
 * Human-only closure is enforced here a second time (spec §8, §6.2): a resolve, defer or n/a whose
 * actor is not `human:*`, or whose `by` / `signed_by` is not the event actor, does not close the
 * decision. It yields an anomaly and the decision stays open. The actor is checked before the payload
 * is validated: the schema types `by` / `signed_by` as human ids, so an event written by `omf` or an
 * agent would otherwise fail validation and be reported as `malformed_event` instead.
 * The first valid closing event wins; a later one is `already_closed`, except that a deferred decision
 * can be closed again by a person (resolve, defer anew, n/a; A21), because an expired deferral counts
 * as open at GATE-1. `decision.rejected` is an audit record and never changes state.
 *
 * Not detected: a `human:*` event appended directly by someone who can write to ~/.omf and recompute the
 * chain. The chain guards against accidents, not against write access (spec §8).
 *
 * The fold does not judge content. Whether a closed record is also valid (a measure for a quantitative
 * class, no leak) is `recordProblems`, and GATE-1 counts that as part of closure.
 */
export function foldDecisions(events: readonly LedgerEvent[], scope: DecisionScope): DecisionState {
  const decisions: DecisionRecord[] = [];
  const byId = new Map<string, DecisionRecord>();
  const anomalies: Anomaly[] = [];

  for (const event of events) {
    if (!event.type.startsWith("decision.")) continue;
    if (event.payload["goal_id"] !== scope.goal_id || event.payload["work_id"] !== scope.work_id) continue;

    const rawId = event.payload["decision_id"];
    const flag = (code: AnomalyCode): void => {
      anomalies.push({ code, decision_id: typeof rawId === "string" ? rawId : null, seq: event.seq });
    };

    const notHuman = NOT_HUMAN_CODE.get(event.type);
    if (notHuman !== undefined && !isHuman(event.actor)) {
      flag(notHuman);
      continue;
    }

    const def = PAYLOAD_DEF.get(event.type);
    if (def === undefined || !validateDef(SCHEMA, def, event.payload).ok) {
      flag("malformed_event");
      continue;
    }
    if (event.type === "decision.rejected") continue;
    const id = rawId as string; // validated above

    if (event.type === "decision.added") {
      const payload = event.payload as unknown as AddedPayload;
      if (byId.has(id)) {
        flag("duplicate_add");
        continue;
      }
      // `interface` is the class of exactly one id, so no other id can smuggle in a second interface.
      if ((payload.class === "interface") !== (id === INTERFACE_DECISION_ID)) {
        flag("interface_misplaced");
        continue;
      }
      const record: DecisionRecord = {
        id,
        class: payload.class,
        question: payload.question,
        qas: payload.qas === undefined ? null : detach(payload.qas),
        response_measure: payload.response_measure === undefined ? null : detach(payload.response_measure),
        status: "open",
        resolution: null,
        deferral: null,
        interface: null,
        na: null,
        added_by: event.actor,
        added_seq: event.seq,
        closed_seq: null,
      };
      decisions.push(record);
      byId.set(id, record);
      continue;
    }

    const record = byId.get(id);
    if (record === undefined) {
      flag("unknown_decision");
      continue;
    }
    // resolved and na are final. A deferred record can be closed again (A21): its deferral may have expired.
    if (record.status === "resolved" || record.status === "na") {
      flag("already_closed");
      continue;
    }

    if (event.type === "decision.resolved") {
      const payload = event.payload as unknown as ResolvedPayload;
      if (payload.resolution.by !== event.actor) {
        flag("resolution_not_human");
        continue;
      }
      if (payload.interface !== undefined && record.class !== "interface") {
        flag("interface_misplaced");
        continue;
      }
      record.status = "resolved";
      record.deferral = null;
      record.resolution = detach(payload.resolution);
      if (payload.response_measure !== undefined) record.response_measure = detach(payload.response_measure);
      record.interface = payload.interface === undefined ? null : detach(payload.interface);
    } else if (event.type === "decision.deferred") {
      const payload = event.payload as unknown as DeferredPayload;
      if (payload.deferral.signed_by !== event.actor) {
        flag("deferral_unsigned");
        continue;
      }
      record.status = "deferred";
      record.deferral = detach(payload.deferral);
    } else {
      const payload = event.payload as unknown as MarkedNaPayload;
      if (payload.by !== event.actor) {
        flag("na_not_human");
        continue;
      }
      record.status = "na";
      record.deferral = null;
      record.na = { rationale: payload.rationale, by: payload.by, at: payload.at };
    }
    record.closed_seq = event.seq;
  }

  return { scope: { ...scope }, decisions, anomalies };
}

export function findDecision(state: DecisionState, id: string): DecisionRecord | null {
  return state.decisions.find((record) => record.id === id) ?? null;
}

/**
 * Hash of what the people signed: the closed decisions in add order, with their id, class, status,
 * response measure and the resolution, deferral, n/a or interface body. It leaves out seqs, signers
 * and timestamps, so the same decisions signed later or by someone else hash the same, and it leaves
 * out open decisions, which have not been signed. The seal records it and each station compares it
 * again, so a decision changed mid-run is detected instead of drifting from the sealed spec.md.
 */
export function decisionsDigest(state: DecisionState): string {
  const closed = state.decisions
    .filter((record) => record.status !== "open")
    .map((record) => ({
      id: record.id,
      class: record.class,
      status: record.status,
      response_measure: record.response_measure,
      resolution:
        record.resolution === null
          ? null
          : {
              choice: record.resolution.choice,
              rationale: record.resolution.rationale,
              rejected: record.resolution.rejected,
            },
      deferral:
        record.deferral === null
          ? null
          : {
              owner: record.deferral.owner,
              reason: record.deferral.reason,
              revisit_trigger: record.deferral.revisit_trigger,
              default: record.deferral.default,
              expires_at: record.deferral.expires_at,
            },
      na: record.na === null ? null : { rationale: record.na.rationale },
      interface: record.interface,
    }));
  return sha256Hex(canonicalize(closed));
}
