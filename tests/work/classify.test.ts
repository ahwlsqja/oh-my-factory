import { describe, expect, it } from "vitest";
import { type EvidenceInputs, emptyEvidenceInputs, resetRoundScopedInputs } from "../../src/work/classify.js";
import { NOT_RUN, ROUND_SCOPED_INPUTS } from "../../src/work/line-types.js";

/** Every input produced and clean: the only inputs from which a success can come. */
function cleanInputs(): EvidenceInputs {
  return {
    audit: { canary_hits: 0, tests_edited: false, prove_test: "pass", judge_config_touched: false },
    sealed: { train: { pass: 4, total: 4, flaky: 0 }, test: { pass: 2, total: 2 } },
    isolation_level: "L2",
    high_risk_paths_touched: [],
    noise_check: "ok",
    gate_line: "OMF_GATES fast=pass",
    plan_summary: "Plan.",
    implementer_notes: "Notes.",
  };
}

describe("evidence inputs (a field nobody produced never reads as passed)", () => {
  it("starts with every input not run and the isolation level unmeasured", () => {
    expect(emptyEvidenceInputs()).toEqual({
      audit: { canary_hits: NOT_RUN, tests_edited: NOT_RUN, prove_test: NOT_RUN, judge_config_touched: NOT_RUN },
      sealed: { train: NOT_RUN, test: NOT_RUN },
      isolation_level: "unmeasured",
      high_risk_paths_touched: NOT_RUN,
      noise_check: NOT_RUN,
      gate_line: NOT_RUN,
      plan_summary: NOT_RUN,
      implementer_notes: NOT_RUN,
    });
  });

  it("hands out a fresh object every time", () => {
    const first = emptyEvidenceInputs();
    first.audit.canary_hits = 3;
    expect(emptyEvidenceInputs().audit.canary_hits).toBe(NOT_RUN);
  });

  it("scopes every field to a round except the isolation level (M3b2-D5)", () => {
    expect([...ROUND_SCOPED_INPUTS].sort()).toEqual([
      "audit",
      "gate_line",
      "high_risk_paths_touched",
      "implementer_notes",
      "noise_check",
      "plan_summary",
      "sealed",
    ]);
    // A new field must be placed on one side or the other: this fails until it is.
    expect(new Set([...ROUND_SCOPED_INPUTS, "isolation_level"])).toEqual(new Set(Object.keys(emptyEvidenceInputs())));
  });

  it("resets exactly the round-scoped fields, in place, and keeps the run-wide isolation level", () => {
    const inputs = cleanInputs();
    const same = inputs;
    resetRoundScopedInputs(inputs);
    expect(inputs).toBe(same);
    expect({ ...inputs, isolation_level: "unmeasured" }).toEqual(emptyEvidenceInputs());
    expect(inputs.isolation_level).toBe("L2");
  });
});
