import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { auditPath } from "../../src/audit/work-audit.js";
import { gate3Gate } from "../../src/gate/gate3-gate.js";
import { isolationPath } from "../../src/isolation/record.js";
import { ledgerEvents } from "../helpers/enforcement-goal.js";
import { type Arrangement, arrangeHealthy, setupGate3 } from "../helpers/gate3-line.js";
import { ALL_L2, RUN, cleanAudit } from "../helpers/gate3-parts.js";

const clean = cleanAudit();
const CASES: [string, Arrangement, string[]][] = [
  [
    "a canary hit",
    { audit: cleanAudit({ canary: { ...clean.canary, hits: [{ surface: "diff", count: 1 }], total: 1 } }) },
    ["canary_hit"],
  ],
  [
    "a canary scan that did not run",
    { audit: cleanAudit({ canary: { ...clean.canary, status: "not_run", surfaces_scanned: [] } }) },
    ["canary_not_scanned"],
  ],
  ["a touched judge file", { audit: cleanAudit({ judge_config_touched: true }) }, ["judge_config_changed"]],
  [
    "a harness image that changed within the run",
    { extraJudge: { harness_context_sha256: "9".repeat(64) } },
    ["judge_config_changed"],
  ],
  [
    "a contradiction canary the candidate passes",
    { judge: { contradiction_rejected: 0 } },
    ["contradiction_canary_passing"],
  ],
  [
    "a judge that ran another commit than the audited head",
    { judge: { candidate_sha: "c".repeat(40) } },
    ["contradiction_canary_not_run"],
  ],
  ["no judge event at all", { judge: null }, ["judge_config_not_checked", "contradiction_canary_not_run"]],
  ["a misconfigured gate line", { gates: { fast: "skip", full: "pass", deep: "skip" } }, ["gate_line_misconfigured"]],
  ["no gate run", { gates: null }, ["gate_line_not_run"]],
  ["a stage measured below the declared level", { levels: { ...ALL_L2, sut: "L1" } }, ["isolation_below_declared"]],
];

describe("gate3Gate", () => {
  it("is GATE-3, passes a healthy round and appends gate3.evaluated with the round", async () => {
    const g = setupGate3();
    expect(gate3Gate().id).toBe("GATE-3");
    arrangeHealthy(g);
    expect(await gate3Gate().evaluate(g.ctx())).toEqual({ gate: "GATE-3", verdict: "pass", reasons: [] });
    expect(ledgerEvents(g.f.fx, "gate3.evaluated").map((event) => event.payload)).toEqual([
      { ...g.scope(), passed: true, failed: [], route: "none" },
    ]);
  });

  it.each(CASES)("fails on %s with the matching closed reason", async (_name, arrangement, reasons) => {
    const g = setupGate3();
    arrangeHealthy(g, arrangement);
    expect(await gate3Gate().evaluate(g.ctx())).toEqual({ gate: "GATE-3", verdict: "fail", reasons });
  });

  it("passes a RED gate line: a failing gate is a result for the classifier, not an integrity break", async () => {
    const g = setupGate3();
    arrangeHealthy(g, { gates: { fast: "fail", full: "pass", deep: "skip" } });
    expect((await gate3Gate().evaluate(g.ctx())).verdict).toBe("pass");
  });

  it("ignores preflight.json and an edited isolation.json, and reads an edited audit file as not run", async () => {
    const g = setupGate3();
    arrangeHealthy(g, { levels: { implementer: "L2", sut: "L2", harness: "L2" } });
    const preflight = { isolation: { declared: "L2", measured: "L2", advisory: true } };
    writeFileSync(join(g.f.fx.location.dir, "preflight.json"), JSON.stringify(preflight));
    writeFileSync(
      isolationPath(g.f.item.dir, RUN),
      JSON.stringify({ schema_version: 1, run_id: RUN, stages: {}, level: "L2" }),
    );
    expect((await gate3Gate().evaluate(g.ctx())).reasons).toEqual(["isolation_unmeasured"]);

    const healthy = setupGate3();
    arrangeHealthy(healthy);
    writeFileSync(auditPath(healthy.f.item.dir, RUN, 1), "{}");
    const result = await gate3Gate().evaluate(healthy.ctx());
    expect(result.reasons).toEqual(["canary_not_scanned", "judge_config_not_checked"]);
  });

  it("never lets round 1 answer round 2", async () => {
    const g = setupGate3();
    arrangeHealthy(g);
    expect(await gate3Gate().evaluate(g.ctx(2))).toEqual({
      gate: "GATE-3",
      verdict: "fail",
      reasons: ["canary_not_scanned", "judge_config_not_checked", "contradiction_canary_not_run", "gate_line_not_run"],
    });
    expect(ledgerEvents(g.f.fx, "gate3.evaluated").map((event) => event.payload.round)).toEqual([2]);
  });

  it("answers not_run gate_error when the context cannot be read, and appends nothing", async () => {
    const g = setupGate3();
    arrangeHealthy(g);
    const broken = { ...g.ctx(), location: null as never };
    expect(await gate3Gate().evaluate(broken)).toEqual({ gate: "GATE-3", verdict: "not_run", reasons: ["gate_error"] });
    expect(ledgerEvents(g.f.fx, "gate3.evaluated")).toEqual([]);
  });
});
