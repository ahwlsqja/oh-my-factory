import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/core/ledger.js";
import { bandsFile } from "../../src/goal/bands.js";
import { lockGoal } from "../../src/goal/goal-lock.js";
import { GoalStopError, measureGoal } from "../../src/goal/measure.js";
import { lockFile } from "../../src/goal/metrics.js";
import { setupGoal } from "../helpers/goal.js";

const types = (dir: string): string[] => new Ledger(dir).readVerified().map((e) => e.type);

describe("measureGoal", () => {
  it("refuses an unapproved goal and records why", () => {
    const fx = setupGoal();
    expect(() => measureGoal(fx.location, "g-fast", { runner: "host" })).toThrow(GoalStopError);
    expect(types(fx.location.dir)).toContain("goal.audit_failed");
    expect(types(fx.location.dir)).not.toContain("metric.measured");
  });

  it("measures the locked metrics and writes a host-only gap report", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    const { report, file } = measureGoal(fx.location, "g-fast", { runner: "host" });
    expect(report).toMatchObject({
      goal_id: "g-fast",
      regime: 1,
      runner: "host",
      isolation: "none",
      needs_reapproval: false,
      target: { metric_id: "m-p95", value: 250, measured: 312, result: { met: false, gap: 62, direction: "decrease", size: "medium" } },
      guardrails: [{ metric_id: "m-errors", status: "unevaluated" }],
    });
    expect(report.metrics.map((m) => [m.metric_id, m.roles, m.value])).toEqual([
      ["m-p95", ["target", "lagging"], 312],
      ["m-errors", ["guardrail"], 0.4],
    ]);
    expect(file.startsWith(join(fx.location.dir, "goals", "g-fast", "reports"))).toBe(true);
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(report);
    expect(types(fx.location.dir).slice(-3)).toEqual(["metric.measured", "metric.measured", "goal.measured"]);
  });

  it("records a failing metric and keeps going", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    writeFileSync(join(fx.repo, "bench", "errors.sh"), "exit 3\n");
    const { report } = measureGoal(fx.location, "g-fast", { runner: "host" });
    expect(report.metrics[1]).toMatchObject({ metric_id: "m-errors", value: null, failure: "exit code 3" });
    expect(report.target.measured).toBe(312);
    expect(types(fx.location.dir)).toContain("metric.measure_failed");
  });

  it("evaluates a guardrail against its bands once the baseline is long enough", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    const file = bandsFile(fx.location.dir, "g-fast", "m-errors");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      "metric: m-errors\nbaseline: rolling_30d\nrules: western_electric\ntiers:\n  3sigma: { action: propose, routes: [pull_request] }\n",
    );
    for (let i = 0; i < 5; i++) {
      expect(measureGoal(fx.location, "g-fast", { runner: "host" }).report.guardrails[0]?.status).toBe("unevaluated");
    }
    expect(measureGoal(fx.location, "g-fast", { runner: "host" }).report.guardrails[0]?.status).toBe("pass");
    writeFileSync(join(fx.repo, "bench", "errors.sh"), "echo 5\n");
    const { report } = measureGoal(fx.location, "g-fast", { runner: "host" });
    expect(report.guardrails[0]?.status).toBe("breach");
    expect(report.metrics[1]).toMatchObject({ band: { status: "breach", tier: "3sigma" }, band_action: "propose" });
    expect(types(fx.location.dir)).toContain("band.breached");
  });

  it("reports a guardrail breach when only a lower tier has an action", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    const file = bandsFile(fx.location.dir, "g-fast", "m-errors");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "metric: m-errors\nbaseline: rolling_30d\nrules: western_electric\ntiers:\n  1sigma: { action: log }\n");
    for (let i = 0; i < 6; i++) measureGoal(fx.location, "g-fast", { runner: "host" });
    writeFileSync(join(fx.repo, "bench", "errors.sh"), "echo 95\n");
    const { report } = measureGoal(fx.location, "g-fast", { runner: "host" });
    expect(report.metrics[1]).toMatchObject({ band: { status: "breach", tier: "3sigma" }, band_action: "log" });
    expect(report.guardrails[0]?.status).toBe("breach");
    const breached = new Ledger(fx.location.dir).readVerified().filter((e) => e.type === "band.breached");
    expect(breached).toHaveLength(1);
    expect(breached[0]?.payload).toMatchObject({ tier: "3sigma", action: "log" });
  });

  it("marks measurements taken while a regime change is pending", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    writeFileSync(join(fx.repo, "bench", "p95.sh"), "echo 100\n");
    const { report } = measureGoal(fx.location, "g-fast", { runner: "host" });
    expect(report.needs_reapproval).toBe(true);
    const events = new Ledger(fx.location.dir).readVerified();
    const measured = events.filter((e) => e.type === "metric.measured");
    expect(measured.length).toBeGreaterThan(0);
    for (const event of measured) expect(event.payload.needs_reapproval).toBe(true);
    const goalMeasured = events.filter((e) => e.type === "goal.measured").at(-1);
    expect(goalMeasured?.payload).toMatchObject({ needs_reapproval: true, target_met: null });
  });

  it("marks measurements of an unchanged goal as approved", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    measureGoal(fx.location, "g-fast", { runner: "host" });
    const events = new Ledger(fx.location.dir).readVerified();
    expect(events.find((e) => e.type === "metric.measured")?.payload.needs_reapproval).toBe(false);
    expect(events.find((e) => e.type === "goal.measured")?.payload).toMatchObject({ needs_reapproval: false, target_met: false });
  });

  it("stops on a tampered lock without measuring", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    const lock = lockFile(fx.location.dir, "g-fast", "m-p95");
    writeFileSync(lock, readFileSync(lock, "utf8").replace('"ms"', '"s"'));
    expect(() => measureGoal(fx.location, "g-fast", { runner: "host" })).toThrow(/metric lock tampered: m-p95/);
    expect(types(fx.location.dir)).not.toContain("metric.measured");
  });

  it("labels a regime change once, and keeps the locked target", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    writeFileSync(fx.goalFile, readFileSync(fx.goalFile, "utf8").replace("value: 250", "value: 400"));
    const first = measureGoal(fx.location, "g-fast", { runner: "host" }).report;
    measureGoal(fx.location, "g-fast", { runner: "host" });
    expect(first.needs_reapproval).toBe(true);
    expect(first.target.value).toBe(250);
    expect(types(fx.location.dir).filter((t) => t === "goal.regime_changed")).toHaveLength(1);
  });
});
