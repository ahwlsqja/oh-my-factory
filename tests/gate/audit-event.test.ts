import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runAudit } from "../../src/audit/work-audit.js";
import { Ledger } from "../../src/core/ledger.js";
import { schemaUrl, validate } from "../../src/core/schema.js";
import { auditCompletedEvent, auditPayloadOf } from "../../src/gate/events.js";
import type { ProveReason } from "../../src/gate/prove-test.js";
import type { RiskRule } from "../../src/work/types.js";
import { SCOPE, auditFixture, auditInput } from "../helpers/audit-diff-fixture.js";
import { makeTempDir } from "../helpers/tmp.js";

// Records the closed lists as objects keyed by the type, so a member added to the type without being added
// here is a compile error in `npm run typecheck`.
const RULES: Record<RiskRule, true> = {
  ci: true,
  auth: true,
  migration: true,
  test: true,
  "goal-factory": true,
  lockfile: true,
  "watched-path": true,
  extra: true,
  undeclared: true,
  unclassifiable: true,
};
const PROVE_REASONS: Record<ProveReason, true> = {
  "test-passed-without-fix": true,
  "working-tree-not-clean": true,
  "invalid-base-ref": true,
  "base-not-ancestor": true,
  "no-non-test-change": true,
  "empty-revert-patch": true,
  "revert-failed": true,
  "baseline-test-failed": true,
  "test-command-unrunnable": true,
  interrupted: true,
};

async function editedTestReport() {
  const fx = auditFixture(
    { "src/a.ts": "1\n", "tests/a.test.ts": "a\n" },
    { "src/a.ts": "2\n", "tests/a.test.ts": "b\n" },
  );
  return runAudit(auditInput(fx));
}

describe("audit.completed event", () => {
  it("carries the closed fields of a real report and nothing else", async () => {
    const report = await editedTestReport();
    expect(auditPayloadOf(report)).toEqual({
      diff_files: 2,
      diff_empty: false,
      tests_edited: 1,
      tests_added: 0,
      canary_status: "scanned",
      canary_hits: 0,
      judge_config_touched: false,
      judge_files_checked: report.judge_files_checked,
      high_risk_paths: 1,
      projections_touched: 0,
      special_entries: 0,
      risk_declared: "normal",
      risk_effective: "high",
      risk_rules: ["test"],
      risk_raised: true,
      prove_status: "PROVEN",
      prove_reason: null,
    });
    expect(report.judge_files_checked).toBeGreaterThan(0);
  });

  it("builds an omf event that the ledger accepts", async () => {
    const report = await editedTestReport();
    const event = auditCompletedEvent(SCOPE, report);
    expect(event.actor).toBe("omf");
    expect(event.type).toBe("audit.completed");
    expect(event.payload).toMatchObject({ ...SCOPE, tests_edited: 1 });
    const ledger = new Ledger(makeTempDir("omf-ledger-"));
    ledger.append(event);
    expect(ledger.readVerified().map((e) => e.type)).toEqual(["audit.completed"]);
  });

  it("refuses a scope that is not three well-formed ids, before any event exists", async () => {
    const report = await editedTestReport();
    expect(() => auditCompletedEvent({ ...SCOPE, run_id: "../x" }, report)).toThrow(/invalid audit.completed event/);
  });

  it("schema: every closed list equals the TypeScript list", () => {
    type Props = Record<string, { enum?: unknown[]; items?: { enum: unknown[] } }>;
    const schema = JSON.parse(readFileSync(schemaUrl("gate-event.schema.json"), "utf8")) as {
      $defs: Record<string, { properties: Props }>;
    };
    const props = schema.$defs.audit_completed_payload?.properties;
    if (props === undefined) throw new Error("gate-event.schema.json has no audit_completed_payload");
    expect([...(props.risk_rules?.items?.enum ?? [])].sort()).toEqual(Object.keys(RULES).sort());
    expect((props.prove_reason?.enum ?? []).filter((v) => v !== null).sort()).toEqual(
      Object.keys(PROVE_REASONS).sort(),
    );
    expect(props.prove_status?.enum).toEqual(["PROVEN", "FAILED", "MISCONFIGURED", "not_run"]);
    expect(props.canary_status?.enum).toEqual(["scanned", "not_run"]);
    expect(props.risk_effective?.enum).toEqual(["normal", "high"]);
  });

  it("schema: refuses free text, unknown members, negative counts and missing fields", async () => {
    const valid = auditCompletedEvent(SCOPE, await editedTestReport()).payload;
    const without = Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "judge_config_touched"));
    const bad: Array<[string, Record<string, unknown>]> = [
      ["an extra key", { ...valid, note: "free text" }],
      ["a free-text prove_reason", { ...valid, prove_reason: "it broke" }],
      ["an unknown risk rule", { ...valid, risk_rules: ["made-up"] }],
      ["a negative count", { ...valid, canary_hits: -1 }],
      ["a malformed run id", { ...valid, run_id: "../x" }],
      ["a missing field", without],
    ];
    expect(validate("gate-event.schema.json", { type: "audit.completed", payload: valid }).ok).toBe(true);
    for (const [name, payload] of bad) {
      expect(validate("gate-event.schema.json", { type: "audit.completed", payload }).ok, name).toBe(false);
    }
  });
});
