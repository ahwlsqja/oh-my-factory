import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/core/ledger.js";
import { bandsFile } from "../../src/goal/bands.js";
import { lockGoal } from "../../src/goal/goal-lock.js";
import { GoalStopError, aggregateGuardrails, measureGoal } from "../../src/goal/measure.js";
import { lockFile } from "../../src/goal/metrics.js";
import { setupGoal, writeBands } from "../helpers/goal.js";

const types = (dir: string): string[] => new Ledger(dir).readVerified().map((e) => e.type);

describe("measureGoal", () => {
  it("refuses an unapproved goal and records why", async () => {
    const fx = setupGoal();
    await expect(measureGoal(fx.location, "g-fast", { runner: "host" })).rejects.toThrow(GoalStopError);
    expect(types(fx.location.dir)).toContain("goal.audit_failed");
    expect(types(fx.location.dir)).not.toContain("metric.measured");
  });

  it("measures the locked metrics and writes a host-only gap report", async () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    const { report, file } = await measureGoal(fx.location, "g-fast", { runner: "host" });
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

  it("records a failing metric and keeps going", async () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    writeFileSync(join(fx.repo, "bench", "errors.sh"), "exit 3\n");
    const { report } = await measureGoal(fx.location, "g-fast", { runner: "host" });
    expect(report.metrics[1]).toMatchObject({ metric_id: "m-errors", value: null, failure: "exit code 3" });
    expect(report.target.measured).toBe(312);
    expect(types(fx.location.dir)).toContain("metric.measure_failed");
  });

  it("evaluates a guardrail against its bands once the baseline is long enough", async () => {
    const fx = setupGoal();
    const file = bandsFile(fx.location.dir, "g-fast", "m-errors");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      "metric: m-errors\nbaseline: rolling_30d\nrules: western_electric\ntiers:\n  3sigma: { action: propose, routes: [pull_request] }\n",
    );
    // Bands are part of the J1 lock, so they must exist before approval or the readings are pending.
    lockGoal(fx.location, "g-fast", "human:dev");
    for (let i = 0; i < 5; i++) {
      expect((await measureGoal(fx.location, "g-fast", { runner: "host" })).report.guardrails[0]?.status).toBe("unevaluated");
    }
    expect((await measureGoal(fx.location, "g-fast", { runner: "host" })).report.guardrails[0]?.status).toBe("pass");
    writeFileSync(join(fx.repo, "bench", "errors.sh"), "echo 5\n");
    const { report } = await measureGoal(fx.location, "g-fast", { runner: "host" });
    expect(report.guardrails[0]?.status).toBe("breach");
    expect(report.metrics[1]).toMatchObject({ band: { status: "breach", tier: "3sigma" }, band_action: "propose" });
    expect(types(fx.location.dir)).toContain("band.breached");
  });

  it("reports a guardrail breach when only a lower tier has an action", async () => {
    const fx = setupGoal();
    const file = bandsFile(fx.location.dir, "g-fast", "m-errors");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "metric: m-errors\nbaseline: rolling_30d\nrules: western_electric\ntiers:\n  1sigma: { action: log }\n");
    lockGoal(fx.location, "g-fast", "human:dev");
    for (let i = 0; i < 6; i++) await measureGoal(fx.location, "g-fast", { runner: "host" });
    writeFileSync(join(fx.repo, "bench", "errors.sh"), "echo 95\n");
    const { report } = await measureGoal(fx.location, "g-fast", { runner: "host" });
    expect(report.metrics[1]).toMatchObject({ band: { status: "breach", tier: "3sigma" }, band_action: "log" });
    expect(report.guardrails[0]?.status).toBe("breach");
    const breached = new Ledger(fx.location.dir).readVerified().filter((e) => e.type === "band.breached");
    expect(breached).toHaveLength(1);
    expect(breached[0]?.payload).toMatchObject({ tier: "3sigma", action: "log" });
  });

  it("marks measurements taken while a regime change is pending", async () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    writeFileSync(join(fx.repo, "bench", "p95.sh"), "echo 100\n");
    const { report } = await measureGoal(fx.location, "g-fast", { runner: "host" });
    expect(report.needs_reapproval).toBe(true);
    const events = new Ledger(fx.location.dir).readVerified();
    const measured = events.filter((e) => e.type === "metric.measured");
    expect(measured.length).toBeGreaterThan(0);
    for (const event of measured) expect(event.payload.needs_reapproval).toBe(true);
    const goalMeasured = events.filter((e) => e.type === "goal.measured").at(-1);
    expect(goalMeasured?.payload).toMatchObject({ needs_reapproval: true, target_met: null });
  });

  it("marks measurements of an unchanged goal as approved", async () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    await measureGoal(fx.location, "g-fast", { runner: "host" });
    const events = new Ledger(fx.location.dir).readVerified();
    expect(events.find((e) => e.type === "metric.measured")?.payload.needs_reapproval).toBe(false);
    expect(events.find((e) => e.type === "goal.measured")?.payload).toMatchObject({ needs_reapproval: false, target_met: false });
  });

  it("stops on a tampered lock without measuring", async () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    const lock = lockFile(fx.location.dir, "g-fast", "m-p95");
    writeFileSync(lock, readFileSync(lock, "utf8").replace('"ms"', '"s"'));
    await expect(measureGoal(fx.location, "g-fast", { runner: "host" })).rejects.toThrow(/metric lock tampered: m-p95/);
    expect(types(fx.location.dir)).not.toContain("metric.measured");
  });

  it("labels a regime change once, and keeps the locked target", async () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    writeFileSync(fx.goalFile, readFileSync(fx.goalFile, "utf8").replace("value: 250", "value: 400"));
    const first = (await measureGoal(fx.location, "g-fast", { runner: "host" })).report;
    await measureGoal(fx.location, "g-fast", { runner: "host" });
    expect(first.needs_reapproval).toBe(true);
    expect(first.target.value).toBe(250);
    expect(types(fx.location.dir).filter((t) => t === "goal.regime_changed")).toHaveLength(1);
  });
});

const lastGuardrails = (dir: string): unknown =>
  new Ledger(dir).readVerified().filter((e) => e.type === "goal.measured").at(-1)?.payload.guardrails;

describe("aggregateGuardrails", () => {
  it("ranks breach over unevaluated over pass, and is none without guardrails", () => {
    const g = (...statuses: ("pass" | "breach" | "unevaluated")[]): { status: "pass" | "breach" | "unevaluated" }[] =>
      statuses.map((status) => ({ status }));
    expect(aggregateGuardrails(g("breach", "unevaluated"))).toBe("breach");
    expect(aggregateGuardrails(g("unevaluated", "pass"))).toBe("unevaluated");
    expect(aggregateGuardrails(g("pass", "pass"))).toBe("pass");
    expect(aggregateGuardrails(g("pass", "breach", "pass"))).toBe("breach");
    expect(aggregateGuardrails([])).toBe("none");
  });
});

describe("measureGoal guardrails and baseline", () => {
  it("records none for a goal without guardrails and unevaluated for a guardrail with no bands", async () => {
    const none = setupGoal({ guardrails: [] });
    lockGoal(none.location, "g-fast", "human:dev");
    await measureGoal(none.location, "g-fast", { runner: "host" });
    expect(lastGuardrails(none.location.dir)).toBe("none");

    const unbanded = setupGoal();
    lockGoal(unbanded.location, "g-fast", "human:dev");
    await measureGoal(unbanded.location, "g-fast", { runner: "host" });
    expect(lastGuardrails(unbanded.location.dir)).toBe("unevaluated");
  });

  it("records pass once the baseline is long enough and breach when the guardrail moves", async () => {
    const fx = setupGoal();
    writeBands(fx, "m-errors");
    lockGoal(fx.location, "g-fast", "human:dev");
    for (let i = 0; i < 5; i++) {
      await measureGoal(fx.location, "g-fast", { runner: "host" });
      expect(lastGuardrails(fx.location.dir)).toBe("unevaluated");
    }
    await measureGoal(fx.location, "g-fast", { runner: "host" });
    expect(lastGuardrails(fx.location.dir)).toBe("pass");
    writeFileSync(join(fx.repo, "bench", "errors.sh"), "echo 5\n");
    await measureGoal(fx.location, "g-fast", { runner: "host" });
    expect(lastGuardrails(fx.location.dir)).toBe("breach");
  });

  it("leaves points measured under a pending regime change out of the baseline", async () => {
    const fx = setupGoal();
    writeBands(fx, "m-errors");
    lockGoal(fx.location, "g-fast", "human:dev");
    const original = readFileSync(fx.goalFile, "utf8");
    const errors = join(fx.repo, "bench", "errors.sh");
    for (let i = 0; i < 3; i++) await measureGoal(fx.location, "g-fast", { runner: "host" });

    writeFileSync(fx.goalFile, original.replace("value: 250", "value: 400"));
    writeFileSync(errors, "echo 9\n");
    for (let i = 0; i < 3; i++) {
      const { report } = await measureGoal(fx.location, "g-fast", { runner: "host" });
      expect(report.needs_reapproval).toBe(true);
    }

    writeFileSync(fx.goalFile, original);
    writeFileSync(errors, "echo 0.4\n");
    const { report } = await measureGoal(fx.location, "g-fast", { runner: "host" });
    expect(report.needs_reapproval).toBe(false);
    // Six earlier points exist, three of them flagged: only the three clean ones are baseline.
    expect(report.metrics[1]?.band).toEqual({ status: "insufficient_baseline", points: 3 });
  });

  it("judges a reading taken under a pending regime change against a clean baseline and keeps it out of the next one", async () => {
    const fx = setupGoal();
    writeBands(fx, "m-errors");
    lockGoal(fx.location, "g-fast", "human:dev");
    const original = readFileSync(fx.goalFile, "utf8");
    for (let i = 0; i < 6; i++) await measureGoal(fx.location, "g-fast", { runner: "host" });

    writeFileSync(fx.goalFile, original.replace("value: 250", "value: 400"));
    writeFileSync(join(fx.repo, "bench", "errors.sh"), "echo 5\n");
    const first = (await measureGoal(fx.location, "g-fast", { runner: "host" })).report;
    const second = (await measureGoal(fx.location, "g-fast", { runner: "host" })).report;

    // Had the first pending point entered the baseline, the second would see mean 1.06 and sigma about 1.6 and breach only at 2 sigma.
    for (const report of [first, second]) {
      expect(report.needs_reapproval).toBe(true);
      expect(report.metrics[1]).toMatchObject({
        band: { status: "breach", tier: "3sigma", mean: expect.closeTo(0.4, 6) },
        band_action: "propose",
      });
    }
    const breached = new Ledger(fx.location.dir).readVerified().filter((e) => e.type === "band.breached");
    expect(breached).toHaveLength(2);
    for (const event of breached) expect(event.payload).toMatchObject({ tier: "3sigma", needs_reapproval: true });
  });
});
