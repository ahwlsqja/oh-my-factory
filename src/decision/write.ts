import { sha256Hex } from "../core/canonical-json.js";
import type { Ledger, LedgerEvent, NewEvent } from "../core/ledger.js";
import { validateDef } from "../core/schema.js";
import { lintDecisionStrings } from "./leak-lint.js";
import type { LeakContext, LeakFinding } from "./leak-lint.js";
import { findDecision, foldDecisions } from "./state.js";
import { DECISION_ID_PATTERN, INTENT_QUESTION_ID_PREFIX, INTERFACE_DECISION_ID, isQuantitative } from "./types.js";
import type {
  AddInput,
  DecisionRecord,
  DecisionScope,
  DecisionState,
  DeferInput,
  InterfaceContract,
  NaInput,
  ResolveInput,
} from "./types.js";

import { DecisionError } from "./errors.js";

export { DecisionError } from "./errors.js";
export type { DecisionErrorCode } from "./errors.js";

/** What every writer needs. intentQuestions = the intent's open_questions in file order (IntentCandidate.open_questions). */
export interface WriteContext {
  leak: LeakContext;
  intentQuestions: readonly string[];
  now: Date;
}

type Op = "add" | "resolve" | "defer" | "na";

const HUMAN_ACTOR = /^human:\S+$/;
const SEED_QUESTION_MAX = 1000;
/** maxItems of ev_rejected.findings in decision.schema.json. */
const MAX_FINDINGS = 50;

/**
 * Closing a decision is a person's act (spec §8). The CLI adds a terminal and a retyped confirmation on top;
 * this check keeps an agent or OMF itself from closing one through the library.
 */
function requireHuman(actor: string, what: string): void {
  if (!HUMAN_ACTOR.test(actor)) {
    throw new DecisionError("not_human", `${what} is a person's decision; ${actor} cannot record it`);
  }
}

function checkInput(def: string, input: unknown): void {
  const result = validateDef("decision.schema.json", def, input);
  if (!result.ok) throw new DecisionError("invalid_input", `invalid input: ${result.errors}`);
}

/**
 * `add` validates its id through add_input; the closing verbs take it as a bare argument, so a library caller could
 * pass anything. A malformed id would make the rejection record fail ev_rejected and the fold would flag it as an
 * anomaly that blocks GATE-1 for good, so it is refused before anything is appended. The id is not echoed.
 */
function requireDecisionId(decisionId: string): void {
  if (!DECISION_ID_PATTERN.test(decisionId))
    throw new DecisionError("invalid_input", "not a valid decision id (d-<slug>)");
}

/** Cross-field rule the schema cannot state: every gate the contract requires must have a command. */
function checkContract(contract: InterfaceContract): void {
  for (const gate of contract.gates.required) {
    if (contract.gates[gate] === null) {
      throw new DecisionError("invalid_input", `gates.required names ${gate}, which has no command`);
    }
  }
}

/**
 * One decision.added (actor omf, class other, id d-intent-q<n>) for each intent open question that has no
 * record yet. The question is cut to the schema's 1000 characters. Not leak-linted here: intent questions
 * are seed-linted when the intent is created, and a later re-lock is caught by recordProblems at GATE-1
 * and withheld from spec.md. Returns unsigned events: the ledger gives them seq, time and hash on append.
 */
export function seedEvents(state: DecisionState, scope: DecisionScope, intentQuestions: readonly string[]): NewEvent[] {
  const seeds: NewEvent[] = [];
  intentQuestions.forEach((text, index) => {
    const id = `${INTENT_QUESTION_ID_PREFIX}${index + 1}`;
    if (findDecision(state, id) !== null) return;
    const question =
      text.trim() === "" ? "(empty open question)" : Array.from(text).slice(0, SEED_QUESTION_MAX).join("");
    seeds.push({
      actor: "omf",
      type: "decision.added",
      payload: { goal_id: scope.goal_id, work_id: scope.work_id, decision_id: id, class: "other", question },
    });
  });
  return seeds;
}

/** Wraps unsigned events as ledger events so the fold can see them before they are written. Never persisted. */
function preview(events: readonly LedgerEvent[], added: readonly NewEvent[]): LedgerEvent[] {
  return added.map(
    (event, index): LedgerEvent => ({
      schema_version: 1,
      seq: events.length + index + 1,
      prev_hash: "",
      ts: "",
      actor: event.actor,
      type: event.type,
      payload: event.payload,
      hash: "",
    }),
  );
}

/**
 * The record a closing verb acts on: it must exist and not be final. An open record and a deferred one can be
 * closed (an expired deferral counts as open at GATE-1, so a person must be able to settle it); `resolved` and
 * `na` are final. Deferring or n/a on the interface is refused.
 */
function openRecord(state: DecisionState, decisionId: string, interfaceClosable: boolean): DecisionRecord {
  const record = findDecision(state, decisionId);
  if (record === null) throw new DecisionError("unknown_decision", `no decision ${decisionId} on this work item`);
  if (record.class === "interface" && !interfaceClosable) {
    throw new DecisionError("interface_not_closable", "the interface decision can only be resolved, with its contract");
  }
  if (record.status === "resolved" || record.status === "na") {
    throw new DecisionError("already_closed", `decision ${decisionId} is already ${record.status}`);
  }
  return record;
}

/**
 * Records a refusal and throws. The rejection names the op, the rule and the field, never the matched text
 * (spec §4.6: the ledger is a log G could one day see). A leaking id is recorded by hash only.
 */
function reject(
  ledger: Ledger,
  scope: DecisionScope,
  op: Op,
  decisionId: string,
  findings: readonly LeakFinding[],
): never {
  const idLeaks = findings.some((finding) => finding.field === "id");
  // ev_rejected allows at most 50 findings; sorted first so the kept ones do not depend on the walk order.
  const kept = [...findings]
    .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0))
    .slice(0, MAX_FINDINGS)
    .map(({ rule, field }) => ({ rule, field }));
  const payload = {
    goal_id: scope.goal_id,
    work_id: scope.work_id,
    op,
    findings: kept,
    ...(idLeaks ? { decision_id_sha12: sha256Hex(decisionId).slice(0, 12) } : { decision_id: decisionId }),
  };
  // A rejection the fold would call malformed is worse than none: it would block GATE-1 with an anomaly.
  const checked = validateDef("decision.schema.json", "ev_rejected", payload);
  if (!checked.ok) throw new DecisionError("invalid_input", `the refusal cannot be recorded: ${checked.errors}`);
  ledger.append({ actor: "omf", type: "decision.rejected", payload });
  const where = kept.map(({ rule, field }) => `${rule} in ${field}`).join(", ");
  throw new DecisionError(
    "leak",
    `refused: the text carries what the goal keeps from the agent (${where}); rewrite it`,
  );
}

/**
 * The one path every writer takes. Leak lint runs on the input before anything else is appended. Then one locked
 * append: seed the intent questions that have no record, fold the ledger plus those seeds, check the
 * preconditions on that state, and return the seeds and the new event together. If a precondition throws,
 * nothing is written, seeds included. So even a first `resolve` sees d-intent-q<n>, and two writers
 * cannot both pass the same duplicate check.
 */
function commit(
  ledger: Ledger,
  scope: DecisionScope,
  op: Op,
  decisionId: string,
  lintBody: Record<string, unknown>,
  ctx: WriteContext,
  build: (state: DecisionState) => NewEvent,
): LedgerEvent {
  const findings = lintDecisionStrings(lintBody, ctx.leak);
  if (op !== "add") {
    // GATE-1 judges an id against the readings recorded up to its add. A closing verb re-checks it against the
    // current lock's terms and target only, so a reading recorded after the add cannot shut the decision out of
    // resolve, defer and n/a alike (which would leave only cancel or veto).
    findings.push(...lintDecisionStrings({ id: decisionId }, { ...ctx.leak, measuredNumbers: [] }));
  }
  if (findings.length > 0) reject(ledger, scope, op, decisionId, findings);
  const written = ledger.appendWithMany((events) => {
    const seeds = seedEvents(foldDecisions(events, scope), scope, ctx.intentQuestions);
    const state = foldDecisions([...events, ...preview(events, seeds)], scope);
    return [...seeds, build(state)];
  });
  const last = written.at(-1);
  if (last === undefined) throw new Error("a decision write appended no event");
  return last;
}

/** Any valid actor may pose a question; it grants nothing. A duplicate id, or a class/id mismatch for the interface, is refused. */
export function addDecision(
  ledger: Ledger,
  scope: DecisionScope,
  input: AddInput,
  actor: string,
  ctx: WriteContext,
): LedgerEvent {
  checkInput("add_input", input);
  if ((input.class === "interface") !== (input.id === INTERFACE_DECISION_ID)) {
    throw new DecisionError(
      "invalid_input",
      `class interface goes with the id ${INTERFACE_DECISION_ID}, and only with it`,
    );
  }
  return commit(ledger, scope, "add", input.id, { ...input }, ctx, (state) => {
    if (findDecision(state, input.id) !== null)
      throw new DecisionError("duplicate_id", `decision ${input.id} already exists`);
    return {
      actor,
      type: "decision.added",
      payload: {
        goal_id: scope.goal_id,
        work_id: scope.work_id,
        decision_id: input.id,
        class: input.class,
        question: input.question,
        ...(input.qas !== undefined ? { qas: input.qas } : {}),
        ...(input.response_measure !== undefined ? { response_measure: input.response_measure } : {}),
      },
    };
  });
}

/**
 * Human only. The interface decision needs its contract, any other class must not carry one, and a quantitative class
 * needs a numeric measure from the add or from this resolution (spec 409).
 */
export function resolveDecision(
  ledger: Ledger,
  scope: DecisionScope,
  decisionId: string,
  input: ResolveInput,
  actor: string,
  ctx: WriteContext,
): LedgerEvent {
  requireHuman(actor, "resolving a decision");
  checkInput("resolve_input", input);
  requireDecisionId(decisionId);
  if (input.interface !== undefined) checkContract(input.interface);
  return commit(ledger, scope, "resolve", decisionId, { ...input }, ctx, (state) => {
    const record = openRecord(state, decisionId, true);
    if (record.class === "interface") {
      if (input.interface === undefined)
        throw new DecisionError("interface_required", "resolving the interface decision needs its contract");
    } else if (input.interface !== undefined) {
      throw new DecisionError("invalid_input", "only the interface decision carries a contract");
    }
    if (isQuantitative(record.class) && (input.response_measure ?? record.response_measure) === null) {
      throw new DecisionError(
        "invalid_input",
        `a ${record.class} decision needs a response_measure with a numeric threshold`,
      );
    }
    return {
      actor,
      type: "decision.resolved",
      payload: {
        goal_id: scope.goal_id,
        work_id: scope.work_id,
        decision_id: decisionId,
        resolution: {
          choice: input.choice,
          rationale: input.rationale,
          rejected: input.rejected ?? [],
          by: actor,
          at: ctx.now.toISOString(),
        },
        ...(input.response_measure !== undefined ? { response_measure: input.response_measure } : {}),
        ...(input.interface !== undefined ? { interface: input.interface } : {}),
      },
    };
  });
}

/** Human only; signed_by is the actor. The interface cannot be deferred, and an expiry at or before now is refused. A deferred decision can be deferred again with a later expiry. */
export function deferDecision(
  ledger: Ledger,
  scope: DecisionScope,
  decisionId: string,
  input: DeferInput,
  actor: string,
  ctx: WriteContext,
): LedgerEvent {
  requireHuman(actor, "deferring a decision");
  checkInput("defer_input", input);
  requireDecisionId(decisionId);
  const expires = Date.parse(input.expires_at);
  if (Number.isNaN(expires)) throw new DecisionError("invalid_input", "expires_at is not a real date");
  if (expires <= ctx.now.getTime()) throw new DecisionError("deferral_in_past", "expires_at must be after now");
  return commit(ledger, scope, "defer", decisionId, { ...input }, ctx, (state) => {
    openRecord(state, decisionId, false);
    return {
      actor,
      type: "decision.deferred",
      payload: {
        goal_id: scope.goal_id,
        work_id: scope.work_id,
        decision_id: decisionId,
        deferral: { ...input, signed_by: actor },
      },
    };
  });
}

/** Human only: the closure for a decision that should never have been asked. The interface cannot be marked n/a. */
export function markNotApplicable(
  ledger: Ledger,
  scope: DecisionScope,
  decisionId: string,
  input: NaInput,
  actor: string,
  ctx: WriteContext,
): LedgerEvent {
  requireHuman(actor, "marking a decision not applicable");
  checkInput("na_input", input);
  requireDecisionId(decisionId);
  return commit(ledger, scope, "na", decisionId, { ...input }, ctx, (state) => {
    openRecord(state, decisionId, false);
    return {
      actor,
      type: "decision.marked_na",
      payload: {
        goal_id: scope.goal_id,
        work_id: scope.work_id,
        decision_id: decisionId,
        rationale: input.rationale,
        by: actor,
        at: ctx.now.toISOString(),
      },
    };
  });
}
