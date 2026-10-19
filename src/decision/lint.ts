import { leakContextAt, lintDecisionStrings } from "./leak-lint.js";
import type { LeakContext } from "./leak-lint.js";
import { INTERFACE_DECISION_ID, isQuantitative } from "./types.js";
import type { DecisionRecord, DecisionState } from "./types.js";

export type LintProblemCode =
  | "anomaly"
  | "measure_missing"
  | "gates_inconsistent"
  | "interface_wrong_class"
  | "interface_body_missing"
  | "leak"
  | "unlinked"
  | "intent_question_missing"
  | "spec_missing"
  | "spec_drift";

/** `detail`, `field` and `rule` name a place and a rule, never the text that triggered them (spec §4.6, ledger-safe). */
export interface LintProblem {
  code: LintProblemCode;
  decision_id: string | null;
  detail?: string;
  field?: string;
  rule?: string;
}

/**
 * The parts of a record a person (or an agent) wrote, in three groups by the event that wrote them, each with its
 * own object for the leak lint. Nulls are left out and so are the bookkeeping fields (status, seqs, added_by):
 * `lintDecisionStrings` skips the OMF-set keys itself. The id is included on purpose: an id is text that reaches
 * `spec.md` and the ledger.
 */
function leakBodies(record: DecisionRecord): { body: Record<string, unknown>; seq: number }[] {
  const added: Record<string, unknown> = { id: record.id, question: record.question };
  if (record.qas !== null) added["qas"] = record.qas;
  const closed: Record<string, unknown> = {};
  if (record.resolution !== null) closed["resolution"] = record.resolution;
  if (record.deferral !== null) closed["deferral"] = record.deferral;
  if (record.interface !== null) closed["interface"] = record.interface;
  if (record.na !== null) closed["na"] = record.na;
  const bodies = [{ body: added, seq: record.added_seq }];
  if (record.response_measure !== null) {
    bodies.push({ body: { response_measure: record.response_measure }, seq: record.measure_seq ?? record.added_seq });
  }
  bodies.push({ body: closed, seq: record.closed_seq ?? record.added_seq });
  return bodies;
}

/**
 * Whether one record is valid on its own, with no I/O. A closed record that is not valid does not count as
 * closed at GATE-1, and `spec.md` withholds it. The order of the problems is fixed, so callers can compare lists.
 *
 * - `interface_wrong_class`: class `interface` is only legal on the id `d-interface`, and that id only on that class.
 * - `measure_missing`: a resolved quantitative decision needs a finite numeric measure (spec §5.2, line 409).
 * - `interface_body_missing`: a resolved interface decision needs its contract.
 * - `gates_inconsistent`: every gate named in `gates.required` needs a command.
 * - `leak`: any leak finding over every string and number the record carries, under the current lock's terms and
 *   target. Each field is judged against the readings recorded up to the event that wrote it: id, question and
 *   qas at `added_seq`; the response measure at `measure_seq`; resolution, deferral, n/a and interface at `closed_seq`.
 */
export function recordProblems(record: DecisionRecord, ctx: LeakContext): LintProblem[] {
  const problems: LintProblem[] = [];
  const id = record.id;

  if ((record.class === "interface") !== (id === INTERFACE_DECISION_ID)) {
    problems.push({ code: "interface_wrong_class", decision_id: id });
  }

  if (record.status === "resolved") {
    if (
      isQuantitative(record.class) &&
      (record.response_measure === null || !Number.isFinite(record.response_measure.threshold))
    ) {
      problems.push({ code: "measure_missing", decision_id: id });
    }
    if (record.class === "interface" && record.interface === null) {
      problems.push({ code: "interface_body_missing", decision_id: id });
    }
  }

  if (record.interface !== null) {
    const { gates } = record.interface;
    for (const name of gates.required) {
      if (gates[name] === null) problems.push({ code: "gates_inconsistent", decision_id: id, detail: name });
    }
  }

  // Readings keep arriving: judge each field against the ones that existed when it was written.
  for (const { body, seq } of leakBodies(record)) {
    for (const finding of lintDecisionStrings(body, leakContextAt(ctx, seq))) {
      problems.push({ code: "leak", decision_id: id, field: finding.field, rule: finding.rule });
    }
  }
  return problems;
}

/**
 * Where scenario links come from. The real vault supplies it; the decision layer only needs the seam, so the link rule can be
 * tested now and switched on later without touching the callers.
 */
export interface DecisionLinks {
  linkedDecisionIds(): ReadonlySet<string>;
}

/**
 * Which resolved decisions a scenario still has to cover (spec §5.2, GATE-2).
 * - `unlinked`: resolved, not quantitative, and no scenario names it. GATE-2 sends the item back to S2 for these.
 * - `not_run`: resolved and quantitative. A CLI scenario cannot prove a latency or a throughput figure in v0.1, so these
 *   are reported as `measured: not_run` and never counted as success.
 * Open, deferred and not-applicable decisions are in neither list: they have no committed answer to cover. Both lists
 * follow `added_seq` order, so the output is stable. Pure; GATE-1 never calls it.
 */
export function scenarioLinkCoverage(
  state: DecisionState,
  linked: ReadonlySet<string>,
): { unlinked: string[]; not_run: string[] } {
  const unlinked: string[] = [];
  const notRun: string[] = [];
  for (const decision of state.decisions) {
    if (decision.status !== "resolved") continue;
    if (isQuantitative(decision.class)) notRun.push(decision.id);
    else if (!linked.has(decision.id)) unlinked.push(decision.id);
  }
  return { unlinked, not_run: notRun };
}

/**
 * Deterministic lint of one work item's decision state (what `omf decide lint` prints). In order:
 *  1. every ledger anomaly, as code `anomaly` with the anomaly code as `detail`;
 *  2. `recordProblems` for every record, in `added_seq` order;
 *  3. `intent_question_missing` for each id in `intentQuestionIds` that has no record (an unseeded question
 *     must not be invisible to lint any more than it is to GATE-1);
 *  4. only when `links` is given: `unlinked` for each resolved non-quantitative decision no scenario names.
 * Without `links` the link rule is skipped, because before the vault exists there are no scenarios to link to.
 */
export function lintDecisions(
  state: DecisionState,
  ctx: LeakContext,
  intentQuestionIds: readonly string[],
  links?: DecisionLinks,
): LintProblem[] {
  const problems: LintProblem[] = [];
  for (const anomaly of state.anomalies) {
    problems.push({ code: "anomaly", decision_id: anomaly.decision_id, detail: anomaly.code });
  }
  for (const decision of state.decisions) problems.push(...recordProblems(decision, ctx));
  const known = new Set(state.decisions.map((decision) => decision.id));
  for (const id of intentQuestionIds) {
    if (!known.has(id)) problems.push({ code: "intent_question_missing", decision_id: id });
  }
  if (links !== undefined) {
    for (const id of scenarioLinkCoverage(state, links.linkedDecisionIds()).unlinked) {
      problems.push({ code: "unlinked", decision_id: id });
    }
  }
  return problems;
}
