import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SURFACE_KINDS } from "../../src/audit/canary-scan.js";
import { type WorkAudit, auditSignals, runAudit } from "../../src/audit/work-audit.js";
import { schemaUrl, validate } from "../../src/core/schema.js";
import { proveTest } from "../../src/gate/prove-test.js";
import { fixtureTarget } from "../helpers/fixture-target.js";
import { type AuditFixture, PROVEN, auditFixture, auditInput, surfacesWith } from "../helpers/audit-diff-fixture.js";
import { gitFixture } from "../helpers/git-fixture.js";
import { realTempDir } from "../helpers/ops-fixture.js";
import { TempWorkCopyFactory } from "../helpers/temp-work-copy.js";

const cleanFixture = (): AuditFixture => auditFixture({ "src/a.ts": "1\n" }, { "src/a.ts": "2\n" });

describe("runAudit test-weakening risk", () => {
  const effective = async (base: Record<string, string>, head: Record<string, string | null>) =>
    (await runAudit(auditInput(auditFixture(base, head)))).risk.effective;

  it("an added test file alone is not high", async () => {
    expect(
      await effective({ "src/a.ts": "1\n" }, { "src/a.ts": "2\n", "tests/new.test.ts": "expect(1).toBe(1);\n" }),
    ).toEqual({
      class: "normal",
      rules: [],
      paths: [],
    });
  });

  it("an edit that keeps every assertion is not high", async () => {
    expect(
      (await effective({ "tests/a.test.ts": "expect(a).toBe(1);\n" }, { "tests/a.test.ts": "expect(a).toBe(2);\n" }))
        .class,
    ).toBe("normal");
  });

  it("raises a declared test-only item to high when its diff removes an assertion", async () => {
    const fx = auditFixture(
      { "tests/a.test.ts": "expect(a).toBe(1);\nexpect(b).toBe(2);\n" },
      { "tests/a.test.ts": "expect(a).toBe(1);\n" },
    );
    const report = await runAudit(auditInput(fx));
    expect(report.risk.declared.class).toBe("normal");
    expect(report.risk.effective).toEqual({ class: "high", rules: ["test-weakening"], paths: ["tests/a.test.ts"] });
    expect(report.risk.raised).toBe(true);
  });

  it("flags a deleted test file whose name has a space", async () => {
    const risk = await effective(
      { "src/a.ts": "1\n", "tests/my file.test.ts": "expect(a).toBe(1);\n" },
      { "tests/my file.test.ts": null, "src/a.ts": "2\n" },
    );
    expect(risk).toEqual({ class: "high", rules: ["test-weakening"], paths: ["tests/my file.test.ts"] });
  });

  it.each([
    [
      "a deleted test file",
      { "tests/a.test.ts": "expect(a).toBe(1);\n" },
      { "tests/a.test.ts": null, "src/a.ts": "x\n" },
    ],
    [
      "a removed assertion",
      { "tests/a.test.ts": "expect(a).toBe(1);\nexpect(b).toBe(2);\n" },
      { "tests/a.test.ts": "expect(a).toBe(1);\n" },
    ],
    [
      "an added skip marker",
      { "tests/a.test.ts": "it('a', () => {});\n" },
      { "tests/a.test.ts": "it.skip('a', () => {});\n" },
    ],
    [
      "an added only marker",
      { "tests/a.test.ts": "it('a', () => {});\n" },
      { "tests/a.test.ts": "it.only('a', () => {});\n" },
    ],
    ["an added todo marker", { "tests/a.test.ts": "it('a', () => {});\n" }, { "tests/a.test.ts": "it.todo('a');\n" }],
    [
      "an x-prefixed marker",
      { "tests/a.test.ts": "it('a', () => {});\n" },
      { "tests/a.test.ts": "xit('a', () => {});\n" },
    ],
    [
      "a lowered coverage threshold",
      { "vitest.config.ts": "  lines: 90,\n" },
      { "vitest.config.ts": "  lines: 70,\n" },
    ],
  ])("%s is high by the rule test-weakening", async (_name, base, head) => {
    const risk = await effective({ "src/a.ts": "1\n", ...base }, head);
    expect(risk.class).toBe("high");
    expect(risk.rules).toEqual(["test-weakening"]);
  });
});

describe("runAudit", () => {
  it("reports a clean source change with every measurement present", async () => {
    const report = await runAudit(auditInput(cleanFixture()));
    expect(report).toEqual({
      schema_version: 1,
      diff: { files: 1, empty: false, special_entries: 0 },
      tests_edited: [],
      tests_edited_count: 0,
      tests_added: 0,
      canary: {
        status: "scanned",
        surfaces_scanned: [...SURFACE_KINDS],
        hits: [],
        total: 0,
        symlinks_skipped: 0,
        truncated: false,
      },
      judge_config_touched: false,
      judge_files_checked: 1,
      projections_touched: [],
      risk: {
        declared: { class: "normal", rules: [], paths: [] },
        recomputed: { class: "normal", rules: [], paths: [] },
        effective: { class: "normal", rules: [], paths: [] },
        raised: false,
      },
      high_risk_paths_touched: [],
      high_risk_paths_count: 0,
      prove_test: PROVEN,
    });
    expect(validate("work-audit.schema.json", report).ok).toBe(true);
  });

  it("lists an edited test, counts an added one, and keeps a test path in the judge files when the gate runs it", async () => {
    const fx = auditFixture(
      { "src/a.ts": "1\n", "tests/a.test.ts": "x\n", "tests/gate.mjs": "a\n" },
      { "tests/a.test.ts": "y\n", "tests/new.test.ts": "z\n", "tests/gate.mjs": "b\n" },
    );
    const judge = {
      gates: { fast: ["node", "tests/gate.mjs"], full: null, deep: null, required: ["fast" as const] },
      test_command: ["node", "--test"],
    };
    const report = await runAudit(auditInput(fx, { judge }));
    expect(report.tests_edited).toEqual(["tests/a.test.ts", "tests/gate.mjs"]); // a file under tests/ is a test path, a gate script included
    expect(report.tests_edited_count).toBe(2);
    expect(report.tests_added).toBe(1);
    expect(report.judge_config_touched).toBe(true); // tests/gate.mjs is a judge file as well
  });

  it("an empty diff has no recompute and no high-risk paths, even when the declared risk lists paths", async () => {
    const fx = cleanFixture();
    const declaredRisk = { class: "high" as const, rules: ["undeclared" as const], paths: ["src/anything.ts"] };
    const report = await runAudit(auditInput({ ...fx, base: fx.head }, { declaredRisk }));
    expect(report.diff).toEqual({ files: 0, empty: true, special_entries: 0 });
    expect(report.risk).toEqual({ declared: declaredRisk, recomputed: null, effective: declaredRisk, raised: false });
    expect(report.high_risk_paths_touched).toEqual([]);
    expect(report.high_risk_paths_count).toBe(0);
  });

  it("raises a declared-normal risk when the diff touches CI, and lists the high-risk paths", async () => {
    const fx = auditFixture(
      { "src/a.ts": "1\n", ".github/workflows/ci.yml": "a\n" },
      { ".github/workflows/ci.yml": "b\n" },
    );
    const report = await runAudit(auditInput(fx));
    expect(report.risk.declared.class).toBe("normal");
    expect(report.risk.effective).toEqual({ class: "high", rules: ["ci"], paths: [".github/workflows/ci.yml"] });
    expect(report.risk.raised).toBe(true);
    expect(report.high_risk_paths_touched).toEqual([".github/workflows/ci.yml"]);
    expect(report.high_risk_paths_count).toBe(1);
  });

  it("flags a touched spec or intent projection", async () => {
    const fx = auditFixture(
      { "spec.md": "a\n", "intent.md": "a\n", "src/a.ts": "1\n" },
      { "spec.md": "b\n", "intent.md": "b\n" },
    );
    const report = await runAudit(auditInput(fx));
    expect(report.projections_touched).toEqual(["intent.md", "spec.md"]);
    expect(report.diff.special_entries).toBe(0);
  });

  it("takes the judge config from the ledger argvs, not from the tree: an edited package.json is not flagged for `node scripts/gates.mjs`", async () => {
    const fx = auditFixture({ "package.json": "{}\n", "src/a.ts": "1\n" }, { "package.json": '{"scripts":{}}\n' });
    expect((await runAudit(auditInput(fx))).judge_config_touched).toBe(false);
    const npm = {
      gates: { fast: ["npm", "test"], full: null, deep: null, required: ["fast" as const] },
      test_command: ["npm", "test"],
    };
    const flagged = await runAudit(auditInput(fx, { judge: npm }));
    expect(flagged.judge_config_touched).toBe(true);
    expect(flagged.judge_files_checked).toBeGreaterThan(1);
  });

  it("judge_files_checked is zero when the commands name no file and no known tool", async () => {
    const judge = {
      gates: { fast: ["my-lint", "--all"], full: null, deep: null, required: ["fast" as const] },
      test_command: ["my-test"],
    };
    const report = await runAudit(auditInput(cleanFixture(), { judge }));
    expect(report.judge_files_checked).toBe(0);
    expect(report.judge_config_touched).toBe(false);
  });

  it("a missing prove-test is the string not_run, and a canary on a surface is a hit on that surface", async () => {
    const report = await runAudit(auditInput(cleanFixture(), { proveTest: null, surfaces: surfacesWith("prompt") }));
    expect(report.prove_test).toBe("not_run");
    expect(report.canary).toMatchObject({ status: "scanned", total: 1, hits: [{ surface: "prompt", count: 1 }] });
  });

  it("caps the listed paths at 200 and keeps the true counts", async () => {
    const names = Array.from({ length: 250 }, (_, i) => `tests/t${String(i).padStart(3, "0")}.test.ts`);
    const base = Object.fromEntries([["src/a.ts", "1\n"], ...names.map((n) => [n, "it('a', () => {});\n"])]);
    const head = Object.fromEntries(names.map((n) => [n, "it.skip('a', () => {});\n"]));
    const report = await runAudit(auditInput(auditFixture(base, head)));
    expect(report.tests_edited).toHaveLength(200);
    expect(report.tests_edited_count).toBe(250);
    expect(report.high_risk_paths_touched).toHaveLength(200);
    expect(report.high_risk_paths_count).toBe(250);
    expect(validate("work-audit.schema.json", report).ok).toBe(true);
  });

  it("prove-test and the audit classify one diff identically when they are given one explicitTestPaths list", async () => {
    const fx = gitFixture(
      { "src/calc.mjs": "export const add = (a, b) => a - b;\n", "e2e/flow.mjs": "export const x = 1;\n" },
      { "src/calc.mjs": "export const add = (a, b) => a + b;\n", "e2e/flow.mjs": "export const x = 2;\n" },
    );
    for (const explicitTestPaths of [[], ["e2e"]]) {
      const parent = realTempDir("omf-parity-");
      const copies = new TempWorkCopyFactory({ parent, exec: (root) => fixtureTarget(root) });
      const prove = await proveTest({
        quarantine: fx.quarantine,
        base: fx.base,
        head: fx.head,
        testCommand: [process.execPath, "--test"],
        explicitTestPaths,
        copies,
        timeoutMs: 60_000,
      });
      const audit = await runAudit(auditInput(fx, { explicitTestPaths, proveTest: null }));
      expect(prove.test_paths).toBe(audit.tests_edited_count + audit.tests_added);
      expect(prove.non_test_paths).toBe(audit.diff.files - prove.test_paths);
    }
  });
});

const REPORT = async (): Promise<WorkAudit> => runAudit(auditInput(cleanFixture()));

describe("auditSignals", () => {
  it("a clean, fully measured audit has no signal", async () => {
    expect(auditSignals(await REPORT())).toEqual({
      flawed: [],
      unverified: [],
      judge_config_touched: false,
      review_required: false,
    });
  });

  it("maps the flawed signals in a fixed order", async () => {
    const report = await REPORT();
    const failed = {
      status: "FAILED" as const,
      reason: "test-passed-without-fix" as const,
      test_exit: 0,
      non_test_paths: 1,
      test_paths: 1,
    };
    expect(auditSignals({ ...report, prove_test: failed }).flawed).toEqual(["prove_test_failed"]);
    expect(
      auditSignals({ ...report, canary: { ...report.canary, total: 1, hits: [{ surface: "diff", count: 1 }] } }).flawed,
    ).toEqual(["canary_hit"]);
    expect(auditSignals({ ...report, tests_edited: ["tests/a.test.ts"], tests_edited_count: 1 }).flawed).toEqual([
      "test_edited",
    ]);
    const all = auditSignals({
      ...report,
      prove_test: failed,
      canary: { ...report.canary, total: 2, hits: [{ surface: "diff", count: 2 }] },
      tests_edited: ["t"],
      tests_edited_count: 1,
    });
    expect(all.flawed).toEqual(["prove_test_failed", "canary_hit", "test_edited"]);
  });

  it("a prove-test that did not run or was misconfigured, and a canary scan that did not run, are unverified and never flawed", async () => {
    const report = await REPORT();
    const misconfigured = {
      status: "MISCONFIGURED" as const,
      reason: "no-non-test-change" as const,
      test_exit: null,
      non_test_paths: 0,
      test_paths: 1,
    };
    const notRun = auditSignals({ ...report, prove_test: "not_run" });
    expect(notRun).toMatchObject({ flawed: [], unverified: ["prove_test_not_run"] });
    expect(auditSignals({ ...report, prove_test: misconfigured })).toMatchObject({
      flawed: [],
      unverified: ["prove_test_misconfigured"],
    });
    const noScan = auditSignals({ ...report, canary: { ...report.canary, status: "not_run", surfaces_scanned: [] } });
    expect(noScan).toMatchObject({ flawed: [], unverified: ["canary_not_scanned"] });
    const both = auditSignals({
      ...report,
      prove_test: "not_run",
      canary: { ...report.canary, status: "not_run", surfaces_scanned: [] },
    });
    expect([...both.unverified].sort()).toEqual(["canary_not_scanned", "prove_test_not_run"]);
  });

  it("a canary hit in a scan that did not finish is both flawed and unverified", async () => {
    const report = await REPORT();
    const signals = auditSignals({
      ...report,
      canary: {
        ...report.canary,
        status: "not_run",
        truncated: true,
        total: 1,
        hits: [{ surface: "worktree", count: 1 }],
      },
    });
    expect(signals.flawed).toEqual(["canary_hit"]);
    expect(signals.unverified).toEqual(["canary_not_scanned"]);
  });

  it("judge_config_touched is its own signal, not a flawed class, and it requires review", async () => {
    const signals = auditSignals({ ...(await REPORT()), judge_config_touched: true });
    expect(signals).toMatchObject({ flawed: [], judge_config_touched: true, review_required: true });
  });

  it.each([
    [
      "an effective high risk",
      (r: WorkAudit): WorkAudit => ({
        ...r,
        risk: { ...r.risk, effective: { class: "high", rules: ["ci"], paths: [] } },
      }),
    ],
    ["a touched projection", (r: WorkAudit): WorkAudit => ({ ...r, projections_touched: ["spec.md"] })],
    ["a special entry", (r: WorkAudit): WorkAudit => ({ ...r, diff: { ...r.diff, special_entries: 1 } })],
  ])("%s requires review", async (_name, change) => {
    expect(auditSignals(change(await REPORT())).review_required).toBe(true);
  });
});

describe("work-audit.schema.json", () => {
  it("keeps the surface and rule enums equal to the TypeScript lists", () => {
    const schema = JSON.parse(readFileSync(schemaUrl("work-audit.schema.json"), "utf8")) as {
      $defs: { surface_kind: { enum: string[] }; risk_rule: { enum: string[] } };
    };
    expect(schema.$defs.surface_kind.enum).toEqual([...SURFACE_KINDS]);
    expect(schema.$defs.risk_rule.enum).toEqual([
      "ci",
      "auth",
      "migration",
      "test",
      "test-weakening",
      "goal-factory",
      "lockfile",
      "watched-path",
      "extra",
      "undeclared",
      "unclassifiable",
    ]);
  });

  it("refuses an extra key, a wrong version, an oversize list, an unknown surface and a free-text reason", async () => {
    const report = await REPORT();
    const bad: Array<[string, unknown]> = [
      ["an extra key", { ...report, note: "free text" }],
      ["schema_version 2", { ...report, schema_version: 2 }],
      ["201 listed tests", { ...report, tests_edited: Array.from({ length: 201 }, () => "t") }],
      ["an unknown surface", { ...report, canary: { ...report.canary, hits: [{ surface: "sut", count: 1 }] } }],
      [
        "a free-text reason",
        {
          ...report,
          prove_test: {
            status: "MISCONFIGURED",
            reason: "it broke",
            test_exit: null,
            non_test_paths: 0,
            test_paths: 0,
          },
        },
      ],
      ["a negative count", { ...report, tests_added: -1 }],
      [
        "a missing field",
        Object.fromEntries(Object.entries(report).filter(([key]) => key !== "high_risk_paths_count")),
      ],
    ];
    expect(validate("work-audit.schema.json", report).ok).toBe(true);
    for (const [name, candidate] of bad) expect(validate("work-audit.schema.json", candidate).ok, name).toBe(false);
  });
});
