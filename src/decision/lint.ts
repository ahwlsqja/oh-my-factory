import { leakContextAt, lintDecisionStrings } from "./leak-lint.js";
import type { LeakContext } from "./leak-lint.js";
import { INTERFACE_DECISION_ID, isQuantitative } from "./types.js";
import type { DecisionRecord } from "./types.js";

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
 * The parts of a record a person (or an agent) wrote, as one object for the leak lint. Nulls are left out and so
 * are the bookkeeping fields (status, seqs, added_by): `lintDecisionStrings` skips the OMF-set keys itself.
 * The id is included on purpose: an id is text that reaches `spec.md` and the ledger (A16b).
 */
function leakBody(record: DecisionRecord): Record<string, unknown> {
  const body: Record<string, unknown> = { id: record.id, question: record.question };
  if (record.qas !== null) body["qas"] = record.qas;
  if (record.response_measure !== null) body["response_measure"] = record.response_measure;
  if (record.resolution !== null) body["resolution"] = record.resolution;
  if (record.deferral !== null) body["deferral"] = record.deferral;
  if (record.interface !== null) body["interface"] = record.interface;
  if (record.na !== null) body["na"] = record.na;
  return body;
}

/**
 * Whether one record is valid on its own, with no I/O (A17). A closed record that is not valid does not count as
 * closed at GATE-1, and `spec.md` withholds it. The order of the problems is fixed, so callers can compare lists.
 *
 * - `interface_wrong_class`: class `interface` is only legal on the id `d-interface`, and that id only on that class.
 * - `measure_missing`: a resolved quantitative decision needs a finite numeric measure (spec §5.2, line 409).
 * - `interface_body_missing`: a resolved interface decision needs its contract.
 * - `gates_inconsistent`: every gate named in `gates.required` needs a command.
 * - `leak`: any leak finding over every string and number the record carries, under the current lock's terms and
 *   target, and the readings recorded up to the record's own last write (`closed_seq`, else `added_seq`; A22).
 */
export function recordProblems(record: DecisionRecord, ctx: LeakContext): LintProblem[] {
  const problems: LintProblem[] = [];
  const id = record.id;

  if ((record.class === "interface") !== (id === INTERFACE_DECISION_ID)) {
    problems.push({ code: "interface_wrong_class", decision_id: id });
  }

  if (record.status === "resolved") {
    if (isQuantitative(record.class) && (record.response_measure === null || !Number.isFinite(record.response_measure.threshold))) {
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

  // Readings keep arriving: judge the record against the ones that existed when it was last written (A22).
  const asOfRecord = leakContextAt(ctx, record.closed_seq ?? record.added_seq);
  for (const finding of lintDecisionStrings(leakBody(record), asOfRecord)) {
    problems.push({ code: "leak", decision_id: id, field: finding.field, rule: finding.rule });
  }
  return problems;
}
