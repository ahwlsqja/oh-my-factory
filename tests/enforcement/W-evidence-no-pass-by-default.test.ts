import { describe, expect, it } from "vitest";
import { runDecideAdd, runDecideResolve } from "../../src/cli/decide.js";
import {
  type Classification,
  type ClassifierInput,
  type ClassifierRule,
  type EvidenceInputs,
  classifyOutcome,
  emptyEvidenceInputs,
  toOutcomeInput,
} from "../../src/work/classify.js";
import {
  EVIDENCE_LABEL,
  type EvidenceBuild,
  type EvidenceDecisions,
  buildEvidence,
  evidenceDecisions,
  renderEvidenceMd,
} from "../../src/work/evidence.js";
import { GateBoard } from "../../src/work/gates.js";
import { GATE_IDS, NOT_RUN } from "../../src/work/line-types.js";
import { type WOutcome, dispositionOf } from "../../src/work/outcome.js";
import type { Recommendation } from "../../src/work/w-events.js";
import { foldWorkBudget } from "../../src/work/w-budget.js";
import { HUMAN, closeInterface, relockTarget, setupDecisionItem } from "../helpers/decision-fixture.js";
import { classifierInput, cleanInputs, okStatuses } from "../helpers/line-enforce.js";

// Spec §5.1 and §6.3: what evidence does not say must not read as passed. The classifier is the only way
// to a recommendation, and `merge_recommended` needs a clean line AND an empty list of unverified areas.
// Each row removes or spoils one thing from the clean input of `classifierInput()` (control: that input is
// `merge_recommended`).
interface Row {
  name: string;
  change: (input: ClassifierInput) => void;
  outcome: WOutcome;
  rule: ClassifierRule;
  recommendation: Recommendation;
}
const incomplete = (name: string, change: Row["change"]): Row => ({
  name,
  change,
  outcome: "blocked",
  rule: "evidence_incomplete",
  recommendation: "human_needed",
});
const unverified = (name: string, change: Row["change"]): Row => ({
  name,
  change,
  outcome: "success",
  rule: "success",
  recommendation: "human_needed",
});
const flawed = (name: string, rule: ClassifierRule, change: Row["change"]): Row => ({
  name,
  change,
  outcome: "flawed",
  rule,
  recommendation: "not_recommended",
});

const ROWS: Row[] = [
  incomplete("audit.canary_hits not run", (c) => void (c.inputs.audit.canary_hits = NOT_RUN)),
  incomplete("audit.tests_edited not run", (c) => void (c.inputs.audit.tests_edited = NOT_RUN)),
  incomplete("audit.prove_test not run", (c) => void (c.inputs.audit.prove_test = NOT_RUN)),
  incomplete("audit.judge_config_touched not run", (c) => void (c.inputs.audit.judge_config_touched = NOT_RUN)),
  incomplete("sealed.train not run", (c) => void (c.inputs.sealed.train = NOT_RUN)),
  incomplete("sealed.test not run", (c) => void (c.inputs.sealed.test = NOT_RUN)),
  incomplete("a sealed total of 0", (c) => void (c.inputs.sealed.train = { pass: 0, total: 0, flaky: 0 })),
  incomplete("gate_line not run", (c) => void (c.inputs.gate_line = NOT_RUN)),
  incomplete("isolation_level unmeasured", (c) => void (c.inputs.isolation_level = "unmeasured")),
  unverified("noise_check not run", (c) => void (c.inputs.noise_check = NOT_RUN)),
  unverified("noise_check not_evaluated", (c) => void (c.inputs.noise_check = "not_evaluated")),
  unverified("high_risk_paths_touched not run", (c) => void (c.inputs.high_risk_paths_touched = NOT_RUN)),
  unverified("high-risk paths touched", (c) => void (c.inputs.high_risk_paths_touched = ["src/a.ts"])),
  unverified("an unmeasured quantitative decision", (c) => void (c.decisions_unmeasured = ["d-latency"])),
  unverified("unknown model spend", (c) => void (c.gate4_warnings = ["spend_unverifiable"])),
  unverified("an injected gate", (c) => void (c.injected_gates = ["GATE-2"])),
  flawed(
    "a gain within run-to-run variance",
    "within_variance",
    (c) => void (c.inputs.noise_check = "within_variance"),
  ),
  flawed(
    "a flaky train scenario",
    "flaky_scenario",
    (c) => void (c.inputs.sealed.train = { pass: 5, total: 5, flaky: 1 }),
  ),
  flawed("a canary hit", "audit_flag", (c) => void (c.inputs.audit.canary_hits = 1)),
  flawed(
    "a failing sealed scenario",
    "sealed_failed",
    (c) => void (c.inputs.sealed.train = { pass: 4, total: 5, flaky: 0 }),
  ),
];

const RUN = "r-20261014T000000Z-ab12";
const WORK = "w-0123456789ab";

function build(
  classification: Classification,
  inputs: EvidenceInputs,
  decisions: EvidenceDecisions = { list: [], masked: false },
): EvidenceBuild {
  const gates = new GateBoard();
  for (const gate of GATE_IDS) gates.record({ gate, verdict: "pass", reasons: [] });
  return {
    scope: { work_id: WORK, goal_id: "g-checkout", run_id: RUN },
    classification,
    stations: okStatuses(),
    gates,
    inputs,
    decisions,
    injected_gates: [],
    stage_times: {},
    budget: foldWorkBudget([], WORK),
    now: new Date("2026-10-14T00:00:00.000Z"),
  };
}

describe("W-evidence-no-pass-by-default", () => {
  it("control: a clean, complete input is merge_recommended with nothing unverified", () => {
    expect(classifyOutcome(classifierInput())).toMatchObject({
      outcome: "success",
      recommendation: "merge_recommended",
      unverified_areas: [],
      rule: "success",
    });
  });

  it.each(ROWS)("$name", (row) => {
    const input = classifierInput();
    row.change(input);
    const classification = classifyOutcome(input);
    expect(classification).toMatchObject({ outcome: row.outcome, rule: row.rule, recommendation: row.recommendation });
    expect(classification.recommendation).not.toBe("merge_recommended");
    expect(() => dispositionOf(toOutcomeInput(classification))).not.toThrow();
  });

  it("with every input not run, the evidence is blocked and lists every field as not run", () => {
    const classification = classifyOutcome(classifierInput({ inputs: emptyEvidenceInputs() }));
    expect(classification).toMatchObject({ outcome: "blocked", rule: "evidence_incomplete" });
    const doc = buildEvidence(build(classification, emptyEvidenceInputs()));
    expect(doc).toMatchObject({ outcome: "blocked", recommendation: "human_needed", label: EVIDENCE_LABEL });
    expect(doc.untrusted_fields).toEqual(["plan_summary", "implementer_notes"]);
    expect(doc.isolation_level).toBe("unmeasured");
    expect(doc.gate_line).toBe(NOT_RUN);
    expect(doc.sealed).toEqual({ train: NOT_RUN, test: NOT_RUN });
    expect(doc.audit).toEqual({
      canary_hits: NOT_RUN,
      tests_edited: NOT_RUN,
      prove_test: NOT_RUN,
      judge_config_touched: NOT_RUN,
    });
    expect(doc.self_metrics.human_interventions_by_J).toBe(NOT_RUN);
    expect(Object.keys(doc).sort()).toEqual(
      [
        "audit",
        "created_at",
        "decisions",
        "gate_line",
        "gates",
        "goal_id",
        "high_risk_paths_touched",
        "implementer_notes",
        "isolation_level",
        "label",
        "noise_check",
        "outcome",
        "plan_summary",
        "recommendation",
        "recommendation_reasons",
        "run_id",
        "schema_version",
        "sealed",
        "self_metrics",
        "stations",
        "unverified_areas",
        "untrusted_fields",
        "work_id",
      ].sort(),
    );
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
    expect(renderEvidenceMd(doc)).toContain("sealing and isolation: not enforced (unmeasured)");
  });

  it("lists the unverified areas first, and keeps a decision that now leaks out of both files", () => {
    const f = setupDecisionItem();
    closeInterface(f);
    runDecideAdd(
      f.fx.location,
      f.workId,
      { id: "d-latency", class: "latency", question: "How fast must a lookup be?" },
      "omf",
    );
    runDecideResolve(
      f.fx.location,
      f.workId,
      "d-latency",
      {
        choice: "Bounded lookup time",
        rationale: "Callers wait on it.",
        rejected: [],
        response_measure: {
          metric: "cache lookup time",
          op: "<=",
          threshold: 2917.5,
          unit: "ms",
          percentile: 95,
          window: null,
        },
      },
      HUMAN,
    );

    // Control: before the re-lock the decision is listed, with measured "not run" and its id as an unverified area.
    const listed = evidenceDecisions(f.fx.location, f.item, f.fx.ledger.readVerified());
    expect(listed.masked).toBe(false);
    expect(listed.list).toMatchObject([{ id: "d-latency", threshold: 2917.5, measured: NOT_RUN }]);
    const classification = classifyOutcome(classifierInput({ decisions_unmeasured: ["d-latency"] }));
    expect(classification.unverified_areas).toContainEqual({ code: "decision_unmeasured", decision_id: "d-latency" });
    const before = buildEvidence(build(classification, cleanInputs(), listed));
    const beforeMd = renderEvidenceMd(before);
    expect(beforeMd.split("\n").find((line) => line.startsWith("#"))).toMatch(/unverified/i);
    expect(JSON.stringify(before)).toContain("2917.5");

    // A goal re-lock makes the threshold equal to the locked target: the record is dropped and masked.
    relockTarget(f, 2917.5);
    const masked = evidenceDecisions(f.fx.location, f.item, f.fx.ledger.readVerified());
    expect(masked).toEqual({ list: [], masked: true });
    const after = buildEvidence(build(classifyOutcome(classifierInput()), cleanInputs(), masked));
    for (const text of [JSON.stringify(after), renderEvidenceMd(after)]) expect(text).not.toContain("2917.5");
  });
});
