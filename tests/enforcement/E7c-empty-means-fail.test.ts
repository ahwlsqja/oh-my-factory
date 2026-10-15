import { describe, expect, it } from "vitest";
import { auditSignals } from "../../src/audit/work-audit.js";
import { GATE_NAMES, type GateName } from "../../src/decision/types.js";
import { evaluateGateLine, gateVerdictPasses, parseGateLine } from "../../src/gate/gate-line.js";
import { runGates } from "../../src/gate/run-gates.js";
import type { CommandTarget } from "../../src/gate/ports.js";
import { type Gate3Parts, evaluateGate3, measuredFrom } from "../../src/gate/gate3.js";
import { cleanAudit, healthyParts } from "../helpers/gate3-parts.js";
import { gate3Gate } from "../../src/gate/gate3-gate.js";
import { setupGate3 } from "../helpers/gate3-line.js";

// E7c (spec §5.0, E7): a missing gate, a missing gate line, a gate with zero rules, a never-produced audit, gate run
// or isolation measurement, and a never-run prove-test are failures or "unverified". None of them reads as a pass.
// The sealed-scenario and judge halves of E7 are other files; this one is the integrity line.

const exited = (stdout: string, status = 0) => ({ kind: "exited" as const, status, signal: null, stdout, stderr: "" });

/** A target that answers by the gate's position in the argv: `["gate", name]`. */
function targetFor(answer: (gate: GateName) => ReturnType<typeof exited>): CommandTarget {
  return { run: async (argv) => answer(argv[1] as GateName) };
}
const declared = (required: readonly GateName[], fill: Record<GateName, string[] | null>) => ({
  ...fill,
  required: [...required],
});
const allDeclared = { fast: ["gate", "fast"], full: ["gate", "full"], deep: ["gate", "deep"] };

describe("E7c: gates", () => {
  it.each(GATE_NAMES)(
    "a required %s gate that is skip, empty, undeclared or absent from the line is MISCONFIGURED",
    async (gate) => {
      const others = GATE_NAMES.filter((name) => name !== gate);
      // empty: the gate ran, exited 0 and reported zero rules.
      const empty = await runGates(
        declared([gate], allDeclared),
        targetFor((name) => (name === gate ? exited("OMF_GATE_RULES: 0\n") : exited("OMF_GATE_RULES: 3\n"))),
      );
      expect(empty.values[gate]).toBe("empty");
      expect(empty.verdict).toMatchObject({
        status: "MISCONFIGURED",
        misconfigured: [gate],
        reasons: ["required_empty"],
      });
      // undeclared: no command, so `skip`.
      const undeclared = await runGates(
        declared([gate], { ...allDeclared, [gate]: null }),
        targetFor(() => exited("")),
      );
      expect(undeclared.values[gate]).toBe("skip");
      expect(undeclared.verdict).toMatchObject({ status: "MISCONFIGURED", reasons: ["required_skipped"] });
      // an absent line, and a line that lacks the gate, are MISCONFIGURED too.
      expect(evaluateGateLine(parseGateLine("no gate line here\n"), [gate])).toMatchObject({
        status: "MISCONFIGURED",
        reasons: ["line_absent"],
      });
      const lacking = `OMF_GATES: ${others.map((name) => `${name}=pass`).join(" ")}`;
      expect(evaluateGateLine(parseGateLine(lacking), [gate])).toMatchObject({
        status: "MISCONFIGURED",
        reasons: ["line_malformed"],
      });
      for (const result of [empty, undeclared]) expect(gateVerdictPasses(result.verdict)).toBe(false);
    },
  );

  it("positive control: the same declaration with real rules is GREEN", async () => {
    const run = await runGates(
      declared(["fast", "full"], allDeclared),
      targetFor(() => exited("OMF_GATE_RULES: 2\n")),
    );
    expect(run.verdict.status).toBe("GREEN");
    expect(run.line).toBe("OMF_GATES: fast=pass full=pass deep=pass");
  });

  it("no required gate at all is MISCONFIGURED, not a pass", async () => {
    const run = await runGates(
      declared([], allDeclared),
      targetFor(() => exited("")),
    );
    expect(run.verdict).toMatchObject({ status: "MISCONFIGURED", reasons: ["no_required_gates"] });
  });
});

describe("E7c: GATE-3 never passes on a measurement that was not produced", () => {
  it("positive control: every part produced and healthy passes", () => {
    expect(evaluateGate3(measuredFrom(healthyParts()))).toEqual({ passed: true, failed: [], route: "none" });
  });

  it("with no part at all GATE-3 fails on every condition that has a not-run state, routed to J7", () => {
    const result = evaluateGate3(
      measuredFrom({ audit: null, gates: null, contradiction: null, isolation: null, declared: "L2" }),
    );
    expect(result.passed).toBe(false);
    expect(result.failed).toEqual([
      "canary_not_scanned",
      "judge_config_not_checked",
      "contradiction_canary_not_run",
      "gate_line_not_run",
      "isolation_unmeasured",
    ]);
    expect(result.route).toBe("J7");
  });

  const ONE_MISSING: Array<[string, Partial<Gate3Parts>, string[], "J6" | "J7"]> = [
    ["audit", { audit: null }, ["canary_not_scanned", "judge_config_not_checked"], "J6"],
    ["gate run", { gates: null }, ["gate_line_not_run"], "J6"],
    ["contradiction verdict", { contradiction: null }, ["contradiction_canary_not_run"], "J6"],
    ["isolation", { isolation: null }, ["isolation_unmeasured"], "J7"],
  ];
  it.each(ONE_MISSING)("a never-produced %s alone stops GATE-3", (_name, over, failed, route) => {
    const result = evaluateGate3(measuredFrom(healthyParts(over)));
    expect(result).toEqual({ passed: false, failed, route });
  });

  it("an audit whose canary scan did not run and one with no judge file checked are not clean", () => {
    const notScanned = cleanAudit({ canary: { ...cleanAudit().canary, status: "not_run", surfaces_scanned: [] } });
    expect(evaluateGate3(measuredFrom(healthyParts({ audit: notScanned }))).failed).toEqual(["canary_not_scanned"]);
    expect(evaluateGate3(measuredFrom(healthyParts({ audit: cleanAudit({ judge_files_checked: 0 }) }))).failed).toEqual(
      ["judge_config_not_checked"],
    );
  });
});

// The prove-test is not a member of `Measured`. A prove-test that never ran, or was MISCONFIGURED (a
// docs-only diff is `no-non-test-change`), is `unverified` through `auditSignals`: never flawed, never a pass.
// The classifier half (that this prevents `success`) is asserted on the real M3b2 classifier in W-test-edit-flawed.
describe("E7c: a prove-test that never ran is unverified", () => {
  it("positive control: a proven prove-test and a complete scan leave nothing unverified", () => {
    expect(auditSignals(cleanAudit())).toMatchObject({ flawed: [], unverified: [] });
  });

  it("not_run is unverified, not flawed", () => {
    const signals = auditSignals(cleanAudit({ prove_test: "not_run" }));
    expect(signals.unverified).toEqual(["prove_test_not_run"]);
    expect(signals.flawed).toEqual([]);
  });

  it("MISCONFIGURED is unverified, not flawed", () => {
    const misconfigured = {
      status: "MISCONFIGURED",
      reason: "no-non-test-change",
      test_exit: null,
      non_test_paths: 0,
      test_paths: 1,
    } as const;
    const signals = auditSignals(cleanAudit({ prove_test: misconfigured }));
    expect(signals.unverified).toEqual(["prove_test_misconfigured"]);
    expect(signals.flawed).toEqual([]);
  });

  it("a canary scan that did not run is unverified, and both gaps are reported together", () => {
    const audit = cleanAudit({
      prove_test: "not_run",
      canary: { ...cleanAudit().canary, status: "not_run", surfaces_scanned: [] },
    });
    expect([...auditSignals(audit).unverified].sort()).toEqual(["canary_not_scanned", "prove_test_not_run"]);
  });
});

describe("E7c: the registered GATE-3", () => {
  it("fails on every measurement nobody recorded, and never passes on an empty ledger", async () => {
    const result = await gate3Gate().evaluate(setupGate3().ctx());
    expect(result).toEqual({
      gate: "GATE-3",
      verdict: "fail",
      reasons: [
        "canary_not_scanned",
        "judge_config_not_checked",
        "contradiction_canary_not_run",
        "gate_line_not_run",
        "isolation_unmeasured",
      ],
    });
  });
});
