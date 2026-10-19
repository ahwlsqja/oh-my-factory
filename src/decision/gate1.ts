import { recordProblems } from "./lint.js";
import type { LintProblemCode } from "./lint.js";
import type { LeakContext } from "./leak-lint.js";
import { INTENT_QUESTION_ID_PREFIX, INTERFACE_DECISION_ID } from "./types.js";
import type { AnomalyCode, DecisionRecord, DecisionState } from "./types.js";

export type Gate1Reason =
  | { code: "interface_missing" }
  | { code: "interface_unresolved" }
  | { code: "intent_question_missing"; decision_id: string }
  | { code: "required_open"; decision_id: string }
  | { code: "resolution_not_human"; decision_id: string }
  | { code: "deferral_unsigned"; decision_id: string }
  | { code: "deferral_expired"; decision_id: string; expires_at: string }
  | { code: "record_invalid"; decision_id: string | null; problem: LintProblemCode }
  | { code: "ledger_anomaly"; decision_id: string | null; anomaly: AnomalyCode };

export type Gate1Result = { status: "pass" } | { status: "blocked_on_user"; j: "J2"; reasons: Gate1Reason[] };

export interface Gate1Context {
  leak: LeakContext;
  /** `intentQuestionIds(n)` for the intent's n open questions. */
  intentQuestionIds: readonly string[];
}

/** A closing actor that counts: a person at a terminal. `omf` and `agent:*` never close a decision. */
const HUMAN_ACTOR = /^human:\S+$/;

/**
 * The ids the open questions of an intent are seeded under: `d-intent-q1` ... `d-intent-q<n>`. Zero, or a
 * count that is not a positive whole number, gives no ids.
 */
export function intentQuestionIds(openQuestionCount: number): string[] {
  const count = Number.isFinite(openQuestionCount) ? Math.max(0, Math.floor(openQuestionCount)) : 0;
  return Array.from({ length: count }, (_, index) => `${INTENT_QUESTION_ID_PREFIX}${index + 1}`);
}

/**
 * Every anomaly is a `ledger_anomaly`, including a closing event the fold refused. An anomaly stays in the state
 * for good, even after a person closes the decision the forged event tried to close, so no decision verb can clear
 * it: the J2 options name cancel or veto. The `resolution_not_human` and `deferral_unsigned` reasons are only
 * for a record that claims to be closed (`closureReason`).
 */
function anomalyReason(code: AnomalyCode, decisionId: string | null): Gate1Reason {
  return { code: "ledger_anomaly", decision_id: decisionId, anomaly: code };
}

/**
 * The reason a record that claims to be closed is not, or null when it really is closed. The fold already refuses
 * non-human closing events; the checks here repeat it so a hand-built or future state cannot slip through.
 */
function closureReason(record: DecisionRecord, now: Date): Gate1Reason | null {
  if (record.status === "resolved") {
    const by = record.resolution?.by ?? "";
    return HUMAN_ACTOR.test(by) ? null : { code: "resolution_not_human", decision_id: record.id };
  }
  if (record.status === "na") {
    const by = record.na?.by ?? "";
    return HUMAN_ACTOR.test(by) ? null : { code: "resolution_not_human", decision_id: record.id };
  }
  if (record.status === "deferred") {
    const deferral = record.deferral;
    if (deferral === null || !HUMAN_ACTOR.test(deferral.signed_by)) {
      return { code: "deferral_unsigned", decision_id: record.id };
    }
    const expires = Date.parse(deferral.expires_at);
    // An expiry that does not parse fails closed, like an expired one.
    if (Number.isNaN(expires) || expires <= now.getTime()) {
      return { code: "deferral_expired", decision_id: record.id, expires_at: deferral.expires_at };
    }
  }
  return null;
}

/**
 * GATE-1, pure (spec §5.2). Passes only when every condition holds; `pass` is never returned together with a
 * reason, because it is returned exactly when the reason list is empty.
 *
 * 1. no decision is open (an expired deferral counts as open);
 * 2. `d-interface` exists and is a human resolution with a body (a deferred or n/a interface is `interface_unresolved`;
 *    an open one is `required_open`; a resolved one with no body is `record_invalid`);
 * 3. every deferral is human-signed and `expires_at > now`;
 * 4. every id in `ctx.intentQuestionIds` is present and closed (F8);
 * 5. a closed record must pass `recordProblems` under `ctx.leak`.
 *
 * Every anomaly yields a reason, so a forged closing event cannot pass. No link input exists: the scenario-link rule
 * belongs to GATE-2 and would deadlock GATE-1.
 */
export function evaluateGate1(state: DecisionState, now: Date, ctx: Gate1Context): Gate1Result {
  const reasons: Gate1Reason[] = [];

  for (const anomaly of state.anomalies) reasons.push(anomalyReason(anomaly.code, anomaly.decision_id));

  const byId = new Map(state.decisions.map((record) => [record.id, record]));
  const contract = byId.get(INTERFACE_DECISION_ID);
  if (contract === undefined) {
    reasons.push({ code: "interface_missing" });
  } else if (contract.status === "deferred" || contract.status === "na") {
    reasons.push({ code: "interface_unresolved" });
  }

  for (const record of state.decisions) {
    if (record.status === "open") {
      reasons.push({ code: "required_open", decision_id: record.id });
      continue;
    }
    const closure = closureReason(record, now);
    if (closure !== null) {
      reasons.push(closure);
      continue;
    }
    const problems = recordProblems(record, ctx.leak);
    const first = problems[0];
    if (first !== undefined) reasons.push({ code: "record_invalid", decision_id: record.id, problem: first.code });
  }

  for (const id of ctx.intentQuestionIds) {
    if (!byId.has(id)) reasons.push({ code: "intent_question_missing", decision_id: id });
  }

  return reasons.length === 0 ? { status: "pass" } : { status: "blocked_on_user", j: "J2", reasons };
}
