import { describe, expect, it } from "vitest";
import { auditInputsOf, auditSignals, runAudit } from "../../src/audit/work-audit.js";
import type { WorkAudit } from "../../src/audit/work-audit.js";
import { PROVEN, auditFixture, auditInput, surfacesWith } from "../helpers/audit-diff-fixture.js";
import { classifyOutcome } from "../../src/work/classify.js";
import { allStations, boardOf, cleanInputs } from "../helpers/evidence-fixture.js";
import type { AuditFixture } from "../helpers/audit-diff-fixture.js";
import { recordAndLoad } from "../helpers/audit-record.js";

// Spec §5.6, M3-D8, M3e-D27: an existing test that a candidate edited is a flawed signal, and a prove-test that did
// not run (or was misconfigured) is an unverified area that never lets a run reach `success`. The audit is read back through
// the ledger (`loadAudit`), the way GATE-3 and the sequencer must read it. The classifier outcome (`flawed` / `audit_flag`,
// `blocked` / `evidence_incomplete`) is asserted below on the real M3b2 classifier; the open-pass sealed-fail signal is M3f.

async function auditedViaLedger(fx: AuditFixture, overrides: Parameters<typeof auditInput>[1] = {}): Promise<WorkAudit> {
  const { loaded } = recordAndLoad(await runAudit(auditInput(fx, overrides)));
  if (loaded === null) throw new Error("the audit did not read back through the ledger");
  return loaded;
}

const editsATest = () =>
  auditFixture({ "src/a.ts": "1\n", "tests/a.test.ts": "expect(1)\n" }, { "src/a.ts": "2\n", "tests/a.test.ts": "expect(2)\n" });
const cleanSource = () => auditFixture({ "src/a.ts": "1\n" }, { "src/a.ts": "2\n" });

describe("W-test-edit-flawed", () => {
  it("an edited existing test is listed and is a flawed signal", async () => {
    const audit = await auditedViaLedger(editsATest());
    expect(audit.tests_edited).toEqual(["tests/a.test.ts"]);
    expect(auditSignals(audit)).toMatchObject({ flawed: ["test_edited"], unverified: [] });
    expect(auditInputsOf(audit)).toEqual({ canary_hits: 0, tests_edited: true, prove_test: "pass", judge_config_touched: false });
  });

  it("a diff that only adds a test is not flawed", async () => {
    const fx = auditFixture({ "src/a.ts": "1\n" }, { "src/a.ts": "2\n", "tests/a.test.ts": "expect(2)\n" });
    const audit = await auditedViaLedger(fx);
    expect(audit.tests_edited).toEqual([]);
    expect(audit.tests_added).toBe(1);
    expect(auditSignals(audit)).toMatchObject({ flawed: [], unverified: [] });
    expect(auditInputsOf(audit).tests_edited).toBe(false);
  });

  it("a prove-test that failed, and a canary hit, are flawed signals too", async () => {
    const failed = { status: "FAILED" as const, reason: "test-passed-without-fix" as const, test_exit: 0, non_test_paths: 1, test_paths: 1 };
    const proveFailed = await auditedViaLedger(cleanSource(), { proveTest: failed });
    const canaryHit = await auditedViaLedger(cleanSource(), { surfaces: surfacesWith("prompt") });
    expect(auditSignals(proveFailed).flawed).toEqual(["prove_test_failed"]);
    expect(auditInputsOf(proveFailed).prove_test).toBe("fail");
    expect(auditSignals(canaryHit).flawed).toEqual(["canary_hit"]);
    expect(auditInputsOf(canaryHit).canary_hits).toBe(1);
  });

  it("a clean audit with a proven test has no flawed and no unverified signal (the control)", async () => {
    const audit = await auditedViaLedger(cleanSource(), { proveTest: PROVEN });
    expect(auditSignals(audit)).toMatchObject({ flawed: [], unverified: [], review_required: false });
    expect(auditInputsOf(audit)).toEqual({ canary_hits: 0, tests_edited: false, prove_test: "pass", judge_config_touched: false });
  });

  it("a prove-test that was not run or misconfigured, and an audit that was never produced, are never flawed and never a pass", async () => {
    const misconfigured = { status: "MISCONFIGURED" as const, reason: "no-non-test-change" as const, test_exit: null, non_test_paths: 0, test_paths: 0 };
    const notRun = await auditedViaLedger(cleanSource(), { proveTest: null });
    const wrongConfig = await auditedViaLedger(cleanSource(), { proveTest: misconfigured });
    expect(auditSignals(notRun)).toMatchObject({ flawed: [], unverified: ["prove_test_not_run"] });
    expect(auditSignals(wrongConfig)).toMatchObject({ flawed: [], unverified: ["prove_test_misconfigured"] });
    for (const audit of [notRun, wrongConfig]) expect(auditInputsOf(audit).prove_test, "prove_test").toBe("not run");
    expect(auditInputsOf(null)).toEqual({ canary_hits: "not run", tests_edited: "not run", prove_test: "not run", judge_config_touched: "not run" });
  });

  it("on the real M3b2 classifier an edited test is flawed / audit_flag and a prove-test that did not run is blocked / evidence_incomplete", async () => {
    const classify = (audit: ReturnType<typeof auditInputsOf>) =>
      classifyOutcome({
        stop: { kind: "none" },
        stations: allStations("ok"),
        gates: boardOf("pass").aggregate(),
        inputs: { ...cleanInputs(), audit },
        decisions_unmeasured: [],
        gate4_warnings: [],
        injected_gates: [],
        declared_level: "L2",
      });
    expect(classify(auditInputsOf(await auditedViaLedger(editsATest())))).toMatchObject({
      outcome: "flawed",
      reason_code: "audit_flag",
      recommendation: "not_recommended",
    });
    expect(classify(auditInputsOf(await auditedViaLedger(cleanSource(), { proveTest: null })))).toMatchObject({
      outcome: "blocked",
      reason_code: "evidence_incomplete",
    });
    expect(classify(auditInputsOf(await auditedViaLedger(cleanSource(), { proveTest: PROVEN }))).outcome).toBe("success");
  });
});
