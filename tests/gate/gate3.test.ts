import { mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { recordAudit, loadAudit } from "../../src/audit/work-audit.js";
import { Ledger } from "../../src/core/ledger.js";
import {
  GATE3_CONDITIONS,
  type Gate3Condition,
  type Measured,
  contradictionState,
  evaluateGate3,
  measuredFrom,
} from "../../src/gate/gate3.js";
import { runGates } from "../../src/gate/run-gates.js";
import type { CommandTarget } from "../../src/gate/ports.js";
import { HEAD_SHA } from "../helpers/audit-diff-fixture.js";
import { ALL_L2, SCOPE, cleanAudit, gateRunOf, healthyParts, isolationFor } from "../helpers/gate3-parts.js";
import { makeTempDir } from "../helpers/tmp.js";

const HEALTHY: Measured = {
  canary: "clean",
  judge_config: "unchanged",
  contradiction_canary: "failing",
  gate_line: "green",
  isolation: { declared: "L2", measured: "L2" },
};
const withField = (over: Partial<Measured>): Measured => ({ ...HEALTHY, ...over });

// Spec §5.0: GATE-3 passes only when nothing is missing and nothing is wrong. `red` is a gate result, not an
// integrity failure; every not_run and every unmeasured is a failure (E7).
describe("evaluateGate3", () => {
  it("passes the healthy tuple with no route", () => {
    expect(evaluateGate3(HEALTHY)).toEqual({ passed: true, failed: [], route: "none" });
  });

  const UNHEALTHY: Array<[string, Measured, Gate3Condition]> = [
    ["canary hit", withField({ canary: "hit" }), "canary_hit"],
    ["canary not run", withField({ canary: "not_run" }), "canary_not_scanned"],
    ["judge config changed", withField({ judge_config: "changed" }), "judge_config_changed"],
    ["judge config not run", withField({ judge_config: "not_run" }), "judge_config_not_checked"],
    ["contradiction canary passing", withField({ contradiction_canary: "passing" }), "contradiction_canary_passing"],
    ["contradiction canary not run", withField({ contradiction_canary: "not_run" }), "contradiction_canary_not_run"],
    ["gate line misconfigured", withField({ gate_line: "misconfigured" }), "gate_line_misconfigured"],
    ["gate line not run", withField({ gate_line: "not_run" }), "gate_line_not_run"],
    [
      "isolation L1 below declared L2",
      withField({ isolation: { declared: "L2", measured: "L1" } }),
      "isolation_below_declared",
    ],
    [
      "isolation unmeasured",
      withField({ isolation: { declared: "L2", measured: "unmeasured" } }),
      "isolation_unmeasured",
    ],
  ];

  it.each(UNHEALTHY)("%s fails with exactly its condition", (_name, measured, condition) => {
    const result = evaluateGate3(measured);
    expect(result.passed).toBe(false);
    expect(result.failed).toEqual([condition]);
  });

  it("covers every condition in the closed list", () => {
    expect(UNHEALTHY.map((row) => row[2]).sort()).toEqual([...GATE3_CONDITIONS].sort());
  });

  it("lets a red gate line pass: a failing gate is a gate result, not an integrity failure", () => {
    expect(evaluateGate3(withField({ gate_line: "red" })).passed).toBe(true);
  });

  it("compares the measured level with the declared one, not for equality", () => {
    expect(evaluateGate3(withField({ isolation: { declared: "L2", measured: "L3" } })).passed).toBe(true);
    expect(evaluateGate3(withField({ isolation: { declared: "L1", measured: "L1" } })).passed).toBe(true);
    expect(evaluateGate3(withField({ isolation: { declared: "L3", measured: "L2" } })).failed).toEqual([
      "isolation_below_declared",
    ]);
  });

  it("routes any isolation condition to J7 and anything else to J6, and lists every condition", () => {
    expect(evaluateGate3(withField({ canary: "hit" })).route).toBe("J6");
    expect(evaluateGate3(withField({ isolation: { declared: "L2", measured: "unmeasured" } })).route).toBe("J7");
    const both = evaluateGate3(withField({ canary: "hit", isolation: { declared: "L2", measured: "L1" } }));
    expect(both).toEqual({ passed: false, failed: ["canary_hit", "isolation_below_declared"], route: "J7" });
  });

  it("fails closed on a value outside the closed lists", () => {
    const forged = { ...HEALTHY, canary: "fine", isolation: { declared: "L2", measured: "L9" } } as unknown as Measured;
    expect(evaluateGate3(forged).failed).toEqual(["canary_not_scanned", "isolation_unmeasured"]);
  });

  it("fails closed on a declared level outside the closed list instead of comparing it as equal", () => {
    for (const declared of ["L9", "", "l2", "unmeasured"]) {
      const forged = { ...HEALTHY, isolation: { declared, measured: "L2" } } as unknown as Measured;
      expect(evaluateGate3(forged), declared).toEqual({
        passed: false,
        failed: ["isolation_below_declared"],
        route: "J7",
      });
    }
  });
});

describe("measuredFrom", () => {
  it("is all not_run and unmeasured when no part exists", () => {
    const measured = measuredFrom({ audit: null, gates: null, contradiction: null, isolation: null, declared: "L2" });
    expect(measured).toEqual({
      canary: "not_run",
      judge_config: "not_run",
      contradiction_canary: "not_run",
      gate_line: "not_run",
      isolation: { declared: "L2", measured: "unmeasured" },
    });
    expect(evaluateGate3(measured).passed).toBe(false);
  });

  it("maps healthy parts to the healthy tuple", () => {
    expect(measuredFrom(healthyParts())).toEqual(HEALTHY);
  });

  it("maps a canary hit, a truncated scan and a scan that did not run", () => {
    const hit = cleanAudit({ canary: { ...cleanAudit().canary, hits: [{ surface: "diff", count: 1 }], total: 1 } });
    expect(measuredFrom(healthyParts({ audit: hit })).canary).toBe("hit");
    // A scan that is `scanned` but truncated is not clean, whatever status says.
    const truncated = cleanAudit({ canary: { ...cleanAudit().canary, truncated: true } });
    expect(measuredFrom(healthyParts({ audit: truncated })).canary).toBe("not_run");
    const notRun = cleanAudit({ canary: { ...cleanAudit().canary, status: "not_run", surfaces_scanned: [] } });
    expect(measuredFrom(healthyParts({ audit: notRun })).canary).toBe("not_run");
    // A hit found before the cap was reached is still a hit.
    const truncatedHit = cleanAudit({
      canary: {
        ...cleanAudit().canary,
        truncated: true,
        status: "not_run",
        total: 1,
        hits: [{ surface: "worktree", count: 1 }],
      },
    });
    expect(measuredFrom(healthyParts({ audit: truncatedHit })).canary).toBe("hit");
  });

  it("gives judge_config not_run when no judge file was checked, and changed when one was touched", () => {
    expect(measuredFrom(healthyParts({ audit: cleanAudit({ judge_files_checked: 0 }) })).judge_config).toBe("not_run");
    expect(measuredFrom(healthyParts({ audit: cleanAudit({ judge_config_touched: true }) })).judge_config).toBe(
      "changed",
    );
  });

  it("maps the gate verdict: GREEN green, RED red, MISCONFIGURED misconfigured", () => {
    const red = gateRunOf({ fast: "fail", full: "pass", deep: "skip" }, ["fast", "full"]);
    const misconfigured = gateRunOf({ fast: "pass", full: "skip", deep: "skip" }, ["fast", "full"]);
    expect(measuredFrom(healthyParts({ gates: red })).gate_line).toBe("red");
    expect(measuredFrom(healthyParts({ gates: misconfigured })).gate_line).toBe("misconfigured");
  });

  it("reads isolation as unmeasured unless all four stages are measured", () => {
    expect(
      measuredFrom(healthyParts({ isolation: isolationFor({ author: "L2", implementer: "L2", sut: "L2" }) })).isolation
        .measured,
    ).toBe("unmeasured");
    expect(
      measuredFrom(healthyParts({ isolation: isolationFor({ ...ALL_L2, harness: "L1" }) })).isolation.measured,
    ).toBe("L1");
    // A hand-built summary that claims a level without being complete is still unmeasured.
    const claimed = { ...isolationFor(ALL_L2), complete: false };
    expect(measuredFrom(healthyParts({ isolation: claimed })).isolation.measured).toBe("unmeasured");
  });

  it("reads real parts: runGates over a target, recordAudit then loadAudit through the ledger", () => {
    const dir = makeTempDir("omf-gate3-");
    const itemDir = `${dir}/item`;
    mkdirSync(itemDir);
    const ledger = new Ledger(dir, () => new Date("2026-10-12T10:00:00.000Z"));
    recordAudit(ledger, SCOPE, itemDir, cleanAudit(), HEAD_SHA);
    const audit = loadAudit(itemDir, SCOPE, ledger.readVerified());
    expect(audit).not.toBeNull();

    const target: CommandTarget = {
      run: async () => ({ kind: "exited", status: 0, signal: null, stdout: "", stderr: "" }),
    };
    return runGates({ fast: ["true"], full: ["true"], deep: null, required: ["fast", "full"] }, target).then(
      (gates) => {
        expect(gates.verdict.status).toBe("GREEN");
        expect(evaluateGate3(measuredFrom(healthyParts({ audit, gates })))).toEqual({
          passed: true,
          failed: [],
          route: "none",
        });
      },
    );
  });

  it("does not accept a GATE-2 result as the contradiction-canary input", () => {
    // Compile-time check: `typecheck` fails if the @ts-expect-error below is unused. Never called.
    const gate2Result = { gate: "GATE-2", result: "failing" };
    // @ts-expect-error a GATE-2 result is not a ContradictionCanaryState
    const wrong = () => measuredFrom(healthyParts({ contradiction: gate2Result }));
    void wrong;
  });
});

// Spec §5.3: the contradiction canary is judged against the CANDIDATE sha. GATE-2's result against the stubs is
// "failing" by construction, so a verdict for any other sha, or one with no contradiction scenario, is not_run.
describe("contradictionState", () => {
  const CANDIDATE = "a".repeat(40);
  const STUBS = "b".repeat(40);
  const verdict = (over: Partial<{ judged_sha: string; contradiction_scenarios: number; rejected: number }> = {}) => ({
    judged_sha: CANDIDATE,
    contradiction_scenarios: 2,
    rejected: 2,
    ...over,
  });

  it("is failing (the healthy state) only when the candidate was judged and every contradiction was rejected", () => {
    expect(contradictionState(verdict(), CANDIDATE)).toBe("failing");
  });

  it("is passing when the judge accepted any contradiction", () => {
    expect(contradictionState(verdict({ rejected: 1 }), CANDIDATE)).toBe("passing");
  });

  it("is not_run for no verdict, a verdict for another sha, zero scenarios or an impossible count", () => {
    expect(contradictionState(null, CANDIDATE)).toBe("not_run");
    expect(contradictionState(verdict({ judged_sha: STUBS }), CANDIDATE)).toBe("not_run");
    expect(contradictionState(verdict({ contradiction_scenarios: 0, rejected: 0 }), CANDIDATE)).toBe("not_run");
    expect(contradictionState(verdict({ rejected: 3 }), CANDIDATE)).toBe("not_run");
    expect(contradictionState(verdict({ rejected: -1 }), CANDIDATE)).toBe("not_run");
    expect(contradictionState(verdict({ rejected: 1.5 }), CANDIDATE)).toBe("not_run");
  });

  it("is not_run when either sha is empty, a placeholder or not a full lowercase hex commit id", () => {
    expect(contradictionState(verdict({ judged_sha: "" }), "")).toBe("not_run");
    expect(contradictionState(verdict({ judged_sha: "HEAD" }), "HEAD")).toBe("not_run");
    expect(contradictionState(verdict({ judged_sha: "abc123" }), "abc123")).toBe("not_run");
    expect(contradictionState(verdict({ judged_sha: "A".repeat(40) }), "A".repeat(40))).toBe("not_run");
    expect(contradictionState(verdict({ judged_sha: "g".repeat(40) }), "g".repeat(40))).toBe("not_run");
    expect(contradictionState(verdict(), "")).toBe("not_run");
  });

  it("accepts a 64-digit commit id", () => {
    const long = "c".repeat(64);
    expect(contradictionState(verdict({ judged_sha: long }), long)).toBe("failing");
  });
});
