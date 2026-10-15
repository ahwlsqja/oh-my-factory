import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditInputsOf,
  auditPath,
  auditSignals,
  loadAudit,
  recordAudit,
  repairAudit,
  runAudit,
} from "../../src/audit/work-audit.js";
import type { RecordSink, WorkAudit } from "../../src/audit/work-audit.js";
import { Ledger } from "../../src/core/ledger.js";
import { classifyOutcome, emptyEvidenceInputs } from "../../src/work/classify.js";
import { aggregateGates } from "../../src/work/gates.js";
import { STATION_IDS } from "../../src/work/line-types.js";
import type { StationId, StationStatus } from "../../src/work/line-types.js";
import { validate } from "../../src/core/schema.js";
import { auditCompletedEvent } from "../../src/gate/events.js";
import { CANARY_TEXT, SCOPE, auditFixture, auditInput, surfacesWith } from "../helpers/audit-diff-fixture.js";
import { recordAndLoad } from "../helpers/audit-record.js";
import { makeTempDir } from "../helpers/tmp.js";

/** A diff that touches no test, no judge file and no projection: the clean baseline every case departs from. */
async function cleanReport(overrides: Parameters<typeof auditInput>[1] = {}): Promise<WorkAudit> {
  const fx = auditFixture({ "src/a.ts": "1\n" }, { "src/a.ts": "2\n" });
  return runAudit(auditInput(fx, overrides));
}

describe("recordAudit", () => {
  it("appends the event before it writes audit.json; the file is private, valid and alone", async () => {
    const report = await cleanReport();
    const itemDir = makeTempDir("omf-item-");
    const ledger = new Ledger(makeTempDir("omf-ledger-"));
    const file = auditPath(itemDir, SCOPE.run_id);
    const fileExistedAtAppend: boolean[] = [];
    const sink: RecordSink = {
      appendWith(build) {
        fileExistedAtAppend.push(existsSync(file));
        return ledger.appendWith(build);
      },
    };

    recordAudit(sink, SCOPE, itemDir, report);

    expect(fileExistedAtAppend).toEqual([false]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(validate("work-audit.schema.json", JSON.parse(readFileSync(file, "utf8"))).ok).toBe(true);
    expect(readdirSync(dirname(file))).toEqual(["audit.json"]);
    expect(ledger.readVerified().map((e) => e.type)).toEqual(["audit.completed"]);
  });

  it("a failure after the event leaves the event and no file, and the audit then reads as absent", async () => {
    const report = await cleanReport();
    const itemDir = makeTempDir("omf-item-");
    writeFileSync(join(itemDir, "runs"), "not a directory"); // the file write cannot create runs/<run_id>/
    const ledger = new Ledger(makeTempDir("omf-ledger-"));

    expect(() => recordAudit(ledger, SCOPE, itemDir, report)).toThrow();

    expect(ledger.readVerified()).toHaveLength(1);
    expect(existsSync(auditPath(itemDir, SCOPE.run_id))).toBe(false);
    expect(loadAudit(itemDir, SCOPE, ledger.readVerified())).toBeNull();
  });

  it("refuses an invalid report before it appends anything", async () => {
    const report = await cleanReport();
    const ledger = new Ledger(makeTempDir("omf-ledger-"));
    const broken = { ...report, schema_version: 2 } as unknown as WorkAudit;
    expect(() => recordAudit(ledger, SCOPE, makeTempDir("omf-item-"), broken)).toThrow(/invalid audit report/);
    expect(ledger.readVerified()).toEqual([]);
  });

  it("keeps the canary out of the event and the file even when a surface holds it", async () => {
    const report = await cleanReport({ surfaces: surfacesWith("implementer_log") });
    expect(report.canary.total).toBe(1);
    const rec = recordAndLoad(report);
    const texts = [readFileSync(rec.ledger.file, "utf8"), readFileSync(auditPath(rec.itemDir, SCOPE.run_id), "utf8")];
    for (const text of texts) expect(text).not.toContain(CANARY_TEXT);
    expect(rec.payload).toMatchObject({ canary_status: "scanned", canary_hits: 1 });
  });
});

const TAMPERS: Array<[string, (r: WorkAudit) => WorkAudit]> = [
  ["canary total", (r) => ({ ...r, canary: { ...r.canary, total: r.canary.total + 3 } })],
  ["canary status", (r) => ({ ...r, canary: { ...r.canary, status: "not_run" as const } })],
  ["judge_config_touched", (r) => ({ ...r, judge_config_touched: !r.judge_config_touched })],
  ["judge_files_checked", (r) => ({ ...r, judge_files_checked: r.judge_files_checked + 5 })],
  ["high_risk_paths_count", (r) => ({ ...r, high_risk_paths_count: r.high_risk_paths_count + 1 })],
  ["tests_edited_count", (r) => ({ ...r, tests_edited_count: r.tests_edited_count + 1 })],
  ["prove status", (r) => ({ ...r, prove_test: "not_run" as const })],
  ["risk class", (r) => ({ ...r, risk: { ...r.risk, effective: { ...r.risk.effective, class: "high" as const } } })],
];

describe("loadAudit", () => {
  it("returns the report that matches its event, also when the same event was recorded twice", async () => {
    const report = await cleanReport();
    const rec = recordAndLoad(report);
    expect(rec.loaded).toEqual(report);
    rec.ledger.append(auditCompletedEvent(SCOPE, report)); // recordAudit refuses a repeat, so a duplicate can only come from a raw append
    expect(loadAudit(rec.itemDir, SCOPE, rec.ledger.readVerified())).toEqual(report);
  });

  it.each(TAMPERS)("rejects a schema-valid file whose %s differs from the event", async (_name, tamper) => {
    const report = await cleanReport();
    const rec = recordAndLoad(report);
    const forged = tamper(report);
    expect(validate("work-audit.schema.json", forged).ok).toBe(true); // the cross-check, not the schema, rejects it
    writeFileSync(auditPath(rec.itemDir, SCOPE.run_id), JSON.stringify(forged));
    expect(loadAudit(rec.itemDir, SCOPE, rec.events)).toBeNull();
  });

  it("reads null for a missing file, a corrupt file and a run id that is not a run id", async () => {
    const rec = recordAndLoad(await cleanReport());
    const file = auditPath(rec.itemDir, SCOPE.run_id);
    writeFileSync(file, "{not json");
    expect(loadAudit(rec.itemDir, SCOPE, rec.events)).toBeNull();
    rmSync(file);
    expect(loadAudit(rec.itemDir, SCOPE, rec.events)).toBeNull();
    expect(loadAudit(rec.itemDir, { ...SCOPE, run_id: "../escape" }, rec.events)).toBeNull();
  });

  it("ignores an event that omf did not write", async () => {
    const report = await cleanReport();
    const itemDir = makeTempDir("omf-item-");
    const ledger = new Ledger(makeTempDir("omf-ledger-"));
    recordAudit(
      { appendWith: (build) => ledger.appendWith((events) => ({ ...build(events), actor: "agent:forger" })) },
      SCOPE,
      itemDir,
      report,
    );
    expect(loadAudit(itemDir, SCOPE, ledger.readVerified())).toBeNull();
  });

  it("gives a file no authority from another run's event", async () => {
    const rec = recordAndLoad(await cleanReport());
    const other = "r-20261014T091500Z-cd34";
    mkdirSync(dirname(auditPath(rec.itemDir, other)), { recursive: true });
    copyFileSync(auditPath(rec.itemDir, SCOPE.run_id), auditPath(rec.itemDir, other));
    expect(loadAudit(rec.itemDir, { ...SCOPE, run_id: other }, rec.events)).toBeNull();
  });

  it("rejects a file that empties high_risk_paths_touched to hide a high-risk diff", async () => {
    const fx = auditFixture(
      { "src/a.ts": "1\n", ".github/workflows/ci.yml": "a\n" },
      { ".github/workflows/ci.yml": "b\n" },
    );
    const report = await runAudit(auditInput(fx));
    expect(report.high_risk_paths_touched).toEqual([".github/workflows/ci.yml"]);
    const rec = recordAndLoad(report);
    const forged = { ...report, high_risk_paths_touched: [], high_risk_paths_count: 0 };
    expect(validate("work-audit.schema.json", forged).ok).toBe(true); // the event cross-check, not the schema, rejects it
    writeFileSync(auditPath(rec.itemDir, SCOPE.run_id), JSON.stringify(forged));
    expect(loadAudit(rec.itemDir, SCOPE, rec.events)).toBeNull();
  });

  it("rejects a file that empties only the path list and keeps the authenticated count", async () => {
    const fx = auditFixture(
      { "src/a.ts": "1\n", ".github/workflows/ci.yml": "a\n" },
      { ".github/workflows/ci.yml": "b\n" },
    );
    const report = await runAudit(auditInput(fx));
    expect(report.high_risk_paths_count).toBe(1);
    const rec = recordAndLoad(report);
    const forged = { ...report, high_risk_paths_touched: [] };
    expect(validate("work-audit.schema.json", forged).ok).toBe(true);
    writeFileSync(auditPath(rec.itemDir, SCOPE.run_id), JSON.stringify(forged));
    expect(loadAudit(rec.itemDir, SCOPE, rec.events)).toBeNull();
    // the same holds for tests_edited, and repairAudit refuses to write such a report
    const edited = { ...report, tests_edited: [], tests_edited_count: 2 };
    const crashed = await crashedRecord(edited);
    expect(await repairAudit(crashed.itemDir, SCOPE, crashed.events, async () => edited)).toBeNull();
  });

  it("gives a file no authority from an event with the same run id but another goal or work item", async () => {
    const report = await cleanReport();
    for (const other of [
      { ...SCOPE, goal_id: "g-someone-else" },
      { ...SCOPE, work_id: "w-ba9876543210" },
    ]) {
      const itemDir = makeTempDir("omf-item-");
      const ledger = new Ledger(makeTempDir("omf-ledger-"));
      recordAudit(ledger, other, itemDir, report);
      expect(loadAudit(itemDir, SCOPE, ledger.readVerified())).toBeNull();
      expect(loadAudit(itemDir, other, ledger.readVerified())).toEqual(report);
    }
  });

  it("refuses a second record for the same run, identical or not, and leaves one event", async () => {
    const report = await cleanReport();
    const rec = recordAndLoad(report);
    const differing = { ...report, canary: { ...report.canary, total: report.canary.total + 3 } };
    expect(() => recordAudit(rec.ledger, SCOPE, rec.itemDir, differing)).toThrow(/already/);
    expect(() => recordAudit(rec.ledger, SCOPE, rec.itemDir, report)).toThrow(/already/);
    expect(rec.ledger.readVerified()).toHaveLength(1);
    expect(loadAudit(rec.itemDir, SCOPE, rec.ledger.readVerified())).toEqual(report);
  });

  it("trusts nothing when two valid events of one run disagree", async () => {
    const report = await cleanReport();
    const rec = recordAndLoad(report);
    const differing = { ...report, canary: { ...report.canary, total: report.canary.total + 3 } };
    rec.ledger.append(auditCompletedEvent(SCOPE, differing));
    expect(loadAudit(rec.itemDir, SCOPE, rec.ledger.readVerified())).toBeNull();
  });
});

/** Records an audit whose file write failed, so the ledger holds the event and the run directory holds nothing. */
async function crashedRecord(report: WorkAudit) {
  const itemDir = makeTempDir("omf-item-");
  const ledger = new Ledger(makeTempDir("omf-ledger-"));
  writeFileSync(join(itemDir, "runs"), "blocker");
  expect(() => recordAudit(ledger, SCOPE, itemDir, report)).toThrow();
  rmSync(join(itemDir, "runs"));
  return { itemDir, ledger, events: ledger.readVerified() };
}

describe("repairAudit", () => {
  it("rewrites the file from a rerun that matches the event, and appends nothing", async () => {
    const report = await cleanReport();
    const { itemDir, ledger, events } = await crashedRecord(report);
    const repaired = await repairAudit(itemDir, SCOPE, events, async () => report);
    expect(repaired).toEqual(report);
    expect(loadAudit(itemDir, SCOPE, events)).toEqual(report);
    expect(ledger.readVerified()).toHaveLength(1);
  });

  it("does nothing when the inputs are gone or the rerun throws", async () => {
    const report = await cleanReport();
    const { itemDir, ledger, events } = await crashedRecord(report);
    expect(await repairAudit(itemDir, SCOPE, events, async () => null)).toBeNull();
    expect(
      await repairAudit(itemDir, SCOPE, events, async () => {
        throw new Error("quarantine repo is gone");
      }),
    ).toBeNull();
    expect(existsSync(auditPath(itemDir, SCOPE.run_id))).toBe(false);
    expect(ledger.readVerified()).toHaveLength(1);
  });

  it("refuses a rerun that differs from the event: no file, no second event", async () => {
    const report = await cleanReport();
    const { itemDir, ledger, events } = await crashedRecord(report);
    const differing = await cleanReport({ surfaces: surfacesWith("diff") });
    expect(await repairAudit(itemDir, SCOPE, events, async () => differing)).toBeNull();
    expect(existsSync(auditPath(itemDir, SCOPE.run_id))).toBe(false);
    expect(ledger.readVerified()).toHaveLength(1);
  });

  it("never reruns when the ledger holds no event for the run", async () => {
    let calls = 0;
    const result = await repairAudit(makeTempDir("omf-item-"), SCOPE, [], async () => {
      calls += 1;
      return null;
    });
    expect(result).toBeNull();
    expect(calls).toBe(0);
  });
});

describe("auditInputsOf", () => {
  it("maps a clean report to produced, healthy inputs", async () => {
    expect(auditInputsOf(await cleanReport())).toEqual({
      canary_hits: 0,
      tests_edited: false,
      prove_test: "pass",
      judge_config_touched: false,
    });
  });

  it("maps every unproduced part to 'not run', never to a healthy value", async () => {
    const report = await cleanReport();
    expect(auditInputsOf(null)).toEqual({
      canary_hits: "not run",
      tests_edited: "not run",
      prove_test: "not run",
      judge_config_touched: "not run",
    });
    expect(auditInputsOf({ ...report, canary: { ...report.canary, status: "not_run" as const } }).canary_hits).toBe(
      "not run",
    );
    expect(auditInputsOf({ ...report, prove_test: "not_run" }).prove_test).toBe("not run");
    expect(
      auditInputsOf({
        ...report,
        prove_test: {
          status: "MISCONFIGURED",
          reason: "no-non-test-change",
          test_exit: null,
          non_test_paths: 0,
          test_paths: 0,
        },
      }).prove_test,
    ).toBe("not run");
    expect(auditInputsOf({ ...report, judge_files_checked: 0 }).judge_config_touched).toBe("not run");
  });

  it("maps the flawed signals", async () => {
    const report = await cleanReport();
    const failed = {
      status: "FAILED" as const,
      reason: "test-passed-without-fix" as const,
      test_exit: 0,
      non_test_paths: 1,
      test_paths: 1,
    };
    expect(auditInputsOf({ ...report, prove_test: failed }).prove_test).toBe("fail");
    expect(auditInputsOf({ ...report, tests_edited: ["tests/a.test.ts"], tests_edited_count: 1 }).tests_edited).toBe(
      true,
    );
    expect(
      auditInputsOf({ ...report, canary: { ...report.canary, hits: [{ surface: "diff", count: 2 }], total: 2 } })
        .canary_hits,
    ).toBe(2);
    expect(auditInputsOf({ ...report, judge_config_touched: true }).judge_config_touched).toBe(true);
  });

  it("keeps a canary hit from a scan that did not finish, and the real classifier calls it flawed", async () => {
    const report = await cleanReport();
    const unfinished = {
      ...report,
      canary: {
        ...report.canary,
        status: "not_run" as const,
        hits: [{ surface: "diff" as const, count: 1 }],
        total: 1,
      },
    };
    expect(auditSignals(unfinished).flawed).toContain("canary_hit");
    const inputs = auditInputsOf(unfinished);
    expect(inputs.canary_hits).toBe(1);
    const stations = Object.fromEntries(STATION_IDS.map((id) => [id, "ok"])) as Record<StationId, StationStatus>;
    const result = classifyOutcome({
      stop: { kind: "gate", gate: "GATE-3", verdict: "fail", reasons: ["canary_hit"] },
      stations,
      gates: aggregateGates({ "GATE-1": "pass", "GATE-2": "pass", "GATE-3": "fail" }),
      inputs: { ...emptyEvidenceInputs(), audit: inputs },
      decisions_unmeasured: [],
      gate4_warnings: [],
      injected_gates: [],
      declared_level: "L2",
    });
    expect(result).toMatchObject({ outcome: "flawed", reason_code: "audit_flag" });
  });
});
