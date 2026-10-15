import { describe, expect, it } from "vitest";
import {
  type EvidenceInputs,
  classifyOutcome,
  resetRoundScopedInputs,
  toOutcomeInput,
} from "../../src/work/classify.js";
import { HANDOFF_ROUTES } from "../../src/work/handoff.js";
import { NOT_RUN } from "../../src/work/line-types.js";
import { dispositionOf } from "../../src/work/outcome.js";
import { classifierInput } from "../helpers/line-enforce.js";

// A failing gate line is a result about the candidate: flawed, not recommended, J4. A misconfigured gate is a setup fault:
// blocked, J7. A verdict nobody produced is incomplete evidence. A result already known to be flawed never needs the
// one-shot test split.
const classify = (change: (inputs: EvidenceInputs) => void) => {
  const input = classifierInput();
  change(input.inputs);
  return classifyOutcome(input);
};

describe("W-red-gate-line-flawed", () => {
  it("control: a GREEN verdict on a clean line is the merge-recommended success", () => {
    expect(classify(() => {})).toMatchObject({ outcome: "success", recommendation: "merge_recommended" });
  });

  it("RED is flawed gates_failed, not recommended, submitted for review at J4", () => {
    const c = classify((inputs) => void (inputs.gate_verdict = "RED"));
    expect(c).toMatchObject({
      outcome: "flawed",
      exhausted: false,
      reason_code: "gates_failed",
      recommendation: "not_recommended",
      rule: "gates_failed",
    });
    expect(dispositionOf(toOutcomeInput(c))).toMatchObject({ action: "submit", recommendation: "not_recommended" });
    expect(HANDOFF_ROUTES.gates_failed.j).toBe("J4");
  });

  it("MISCONFIGURED is blocked gate_blocked (J7), and a verdict nobody produced is evidence_incomplete", () => {
    const misconfigured = classify((inputs) => void (inputs.gate_verdict = "MISCONFIGURED"));
    expect(misconfigured).toMatchObject({
      outcome: "blocked",
      reason_code: "gate_blocked",
      rule: "gates_misconfigured",
    });
    expect(HANDOFF_ROUTES.gate_blocked.j).toBe("J7");
    const missing = classify((inputs) => void (inputs.gate_verdict = NOT_RUN));
    expect(missing).toMatchObject({ outcome: "blocked", reason_code: "evidence_incomplete" });
  });

  const KNOWN_FLAWED: [string, (inputs: EvidenceInputs) => void, string][] = [
    ["a RED gate line", (inputs) => void (inputs.gate_verdict = "RED"), "gates_failed"],
    ["a canary hit", (inputs) => void (inputs.audit.canary_hits = 1), "audit_flag"],
    [
      "a flaky train scenario",
      (inputs) => void (inputs.sealed.train = { pass: 4, total: 4, flaky: 1 }),
      "flaky_scenario",
    ],
  ];
  it.each(KNOWN_FLAWED)("%s classifies without the test split", (_name, change, reason) => {
    const c = classify((inputs) => {
      change(inputs);
      inputs.sealed.test = NOT_RUN;
    });
    expect(c).toMatchObject({ outcome: "flawed", reason_code: reason });
  });

  it("a clean line without the test split, and a RED line without a train count, are still incomplete", () => {
    const noSplit = classify((inputs) => void (inputs.sealed.test = NOT_RUN));
    expect(noSplit).toMatchObject({ outcome: "blocked", reason_code: "evidence_incomplete" });
    const noTrain = classify((inputs) => {
      inputs.gate_verdict = "RED";
      inputs.sealed.train = NOT_RUN;
    });
    expect(noTrain).toMatchObject({ outcome: "blocked", reason_code: "evidence_incomplete" });
  });

  it("goes back to not run when a round opens", () => {
    const inputs = classifierInput().inputs;
    inputs.gate_verdict = "RED";
    resetRoundScopedInputs(inputs);
    expect(inputs.gate_verdict).toBe(NOT_RUN);
  });
});
