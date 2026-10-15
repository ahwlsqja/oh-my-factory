import { describe, expect, it } from "vitest";
import { auditSignals, runAudit } from "../../src/audit/work-audit.js";
import type { JudgeConfigDecl } from "../../src/decision/types.js";
import { auditFixture, auditInput } from "../helpers/audit-diff-fixture.js";
import { recordAndLoad } from "../helpers/audit-record.js";

// Spec §5.6, §4.4, M3e-D13 (W-judge-config-touched) and M3e-D17 (W-spec-intent-diff-flagged): a candidate that edits the
// judge, the gate scripts, the runner config or the spec and intent projections is flagged, and the flag reaches
// the `audit.completed` event, which is the authority, not only the audit.json view.
const NPM_TEST = { gates: { fast: ["npm", "test"], full: null, deep: null, required: ["fast" as const] }, test_command: ["node", "--test"] };
const GATE_UNDER_TESTS = { gates: { fast: ["node", "scripts/gates.mjs"], full: ["node", "tests/gate.mjs"], deep: null, required: ["fast" as const] }, test_command: ["node", "--test"] };

interface Row {
  name: string;
  base: Record<string, string>;
  head: Record<string, string | null>;
  judge?: JudgeConfigDecl;
  judge_config_touched: boolean;
  projections_touched: number;
  tests_edited: number;
}

const ROWS: Row[] = [
  { name: "an edited gate script named in a gate command", base: { "src/a.ts": "1\n" }, head: { "scripts/gates.mjs": "process.exit(1);\n" }, judge_config_touched: true, projections_touched: 0, tests_edited: 0 },
  { name: "an edited package.json when the gate is npm test", base: { "package.json": "{\"scripts\":{\"test\":\"x\"}}\n", "src/a.ts": "1\n" }, head: { "package.json": "{\"scripts\":{\"test\":\"true\"}}\n" }, judge: NPM_TEST, judge_config_touched: true, projections_touched: 0, tests_edited: 0 },
  { name: "an added runner config", base: { "package.json": "{}\n", "src/a.ts": "1\n" }, head: { "vitest.config.ts": "export default {};\n" }, judge: NPM_TEST, judge_config_touched: true, projections_touched: 0, tests_edited: 0 },
  { name: "an edited gate script under tests/ (also a test edit)", base: { "tests/gate.mjs": "a\n", "src/a.ts": "1\n" }, head: { "tests/gate.mjs": "b\n" }, judge: GATE_UNDER_TESTS, judge_config_touched: true, projections_touched: 0, tests_edited: 1 },
  { name: "an edited spec.md", base: { "spec.md": "a\n", "src/a.ts": "1\n" }, head: { "spec.md": "b\n" }, judge_config_touched: false, projections_touched: 1, tests_edited: 0 },
  { name: "an edited intent.md", base: { "intent.md": "a\n", "src/a.ts": "1\n" }, head: { "intent.md": "b\n" }, judge_config_touched: false, projections_touched: 1, tests_edited: 0 },
];

describe("W-audit-flags", () => {
  it.each(ROWS)("reports $name", async (row) => {
    const report = await runAudit(auditInput(auditFixture(row.base, row.head), row.judge === undefined ? {} : { judge: row.judge }));
    const { payload, loaded } = recordAndLoad(report);

    expect(loaded, "read back through the ledger").not.toBeNull();
    expect(payload).toMatchObject({
      judge_config_touched: row.judge_config_touched,
      projections_touched: row.projections_touched,
      tests_edited: row.tests_edited,
    });
    if (loaded === null) return;
    expect(auditSignals(loaded).judge_config_touched).toBe(row.judge_config_touched);
    expect(auditSignals(loaded).review_required).toBe(true);
  });

  it("reports nothing for a diff that touches none of them, and the judge check really ran", async () => {
    const fx = auditFixture({ "src/a.ts": "1\n", "spec.md": "a\n", "intent.md": "a\n" }, { "src/a.ts": "2\n" });
    const { payload, loaded } = recordAndLoad(await runAudit(auditInput(fx)));
    expect(payload).toMatchObject({ judge_config_touched: false, projections_touched: 0, tests_edited: 0, special_entries: 0 });
    expect(Number(payload.judge_files_checked)).toBeGreaterThan(0); // "unchanged" is a measurement, not a default
    expect(loaded).not.toBeNull();
    if (loaded === null) return;
    expect(auditSignals(loaded)).toMatchObject({ flawed: [], judge_config_touched: false, review_required: false });
  });
});
