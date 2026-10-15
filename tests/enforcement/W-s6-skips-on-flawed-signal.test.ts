import { describe, expect, it } from "vitest";
import type { EvidenceInputs } from "../../src/work/classify.js";
import { setupLine } from "../helpers/line.js";
import {
  type Verdict,
  classifyLine,
  cleanInputs,
  contextOf,
  declareDisclosure,
  judgeSpy,
  roundState,
  slot,
  spentOf,
  stationOf,
  typesOf,
} from "../helpers/s6-fixture.js";

interface Case {
  label: string;
  mutate: (inputs: EvidenceInputs) => void;
  flawedSignal: boolean;
  train: readonly Verdict[];
  expected: { outcome: string; reason_code: string; rule: string };
}

const ALL_PASS: readonly Verdict[] = [];
const FLAKY_ONLY: readonly Verdict[] = ["pass", "pass", "pass", "pass", "pass", "flaky"];

const CASES: Case[] = [
  {
    label: "a RED gate line",
    mutate: (i) => {
      i.gate_verdict = "RED";
    },
    flawedSignal: true,
    train: ALL_PASS,
    expected: { outcome: "flawed", reason_code: "gates_failed", rule: "gates_failed" },
  },
  {
    label: "a MISCONFIGURED gate line",
    mutate: (i) => {
      i.gate_verdict = "MISCONFIGURED";
    },
    flawedSignal: true,
    train: ALL_PASS,
    expected: { outcome: "blocked", reason_code: "gate_blocked", rule: "gates_misconfigured" },
  },
  {
    label: "a prove-test that FAILED",
    mutate: (i) => {
      i.audit.prove_test = "fail";
    },
    flawedSignal: true,
    train: ALL_PASS,
    expected: { outcome: "flawed", reason_code: "audit_flag", rule: "audit_flag" },
  },
  {
    label: "edited tests",
    mutate: (i) => {
      i.audit.tests_edited = true;
    },
    flawedSignal: true,
    train: ALL_PASS,
    expected: { outcome: "flawed", reason_code: "audit_flag", rule: "audit_flag" },
  },
  {
    label: "a flaky train scenario and no failure",
    mutate: (i) => {
      i.sealed.train = { pass: 5, total: 6, flaky: 1 };
    },
    flawedSignal: false,
    train: FLAKY_ONLY,
    expected: { outcome: "flawed", reason_code: "flaky_scenario", rule: "flaky_scenario" },
  },
];

// Spec §5.5: the test split is used exactly once, so a line that is already known to be flawed does not spend it.
describe("W-s6-skips-on-flawed-signal", () => {
  it.each(CASES)("spends nothing for $label, and the classifier still reads the line without the split", async (c) => {
    const l = setupLine();
    const spy = judgeSpy(l);
    const inputs = cleanInputs();
    c.mutate(inputs);

    const result = await stationOf(l, roundState(c.train, { flawed_signal: c.flawedSignal }), spy.judge, slot()).run(
      contextOf(l, inputs),
    );

    expect(result).toEqual({ kind: "ok" });
    expect(spy.calls).toEqual([]);
    expect(spentOf(l)).toEqual([]);
    expect(inputs.sealed.test).toBe("not run");
    expect(inputs.noise_check).toBe("not_evaluated");
    expect(classifyLine(inputs)).toMatchObject(c.expected);
  });

  it("lets a flawed signal win over a failing train batch: no feedback, no disclosure unit", async () => {
    const l = setupLine();
    declareDisclosure(l, 40);
    const feedback = slot();
    const state = roundState(["fail", "fail", "pass", "pass", "pass", "pass"], { flawed_signal: true });

    expect(await stationOf(l, state, judgeSpy(l).judge, feedback).run(contextOf(l))).toEqual({ kind: "ok" });

    expect(feedback.puts).toEqual([]);
    expect(typesOf(l)).not.toContain("feedback.released");
    expect(typesOf(l)).not.toContain("budget.consumed");
  });

  it("leaves a clean line incomplete until the split has run", () => {
    expect(classifyLine(cleanInputs())).toMatchObject({ outcome: "blocked", reason_code: "evidence_incomplete" });
  });
});
