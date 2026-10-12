import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { auditGoal } from "../../src/goal/audit.js";
import { goalLockFile, lockGoal } from "../../src/goal/goal-lock.js";
import { lockFile, proposeMetric } from "../../src/goal/metrics.js";
import { setupGoal } from "../helpers/goal.js";

describe("auditGoal", () => {
  it("reports a draft that is missing a metric proposal", () => {
    const fx = setupGoal({ guardrails: ["m-unknown"] });
    const report = auditGoal(fx.location, "g-fast");
    expect(report.state).toBe("draft");
    expect(report.problems).toEqual(["metric m-unknown has no proposal; run omf metric propose m-unknown"]);
  });

  it("reports a draft that is ready for J1", () => {
    const report = auditGoal(setupGoal().location, "g-fast");
    expect(report).toMatchObject({ state: "draft", problems: [], regime_changes: [], approval: null });
  });

  it("reports an approved goal with its locks and budget", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    const report = auditGoal(fx.location, "g-fast");
    expect(report).toMatchObject({ state: "approved", problems: [], regime_changes: [], wall_time_exceeded: false });
    expect(report.approval?.regime).toBe(1);
    expect(report.locked?.metrics.map((m) => m.metric_id)).toEqual(["m-p95", "m-errors"]);
    expect(report.budget?.remaining).toBe(10);
  });

  it("treats an edit to goal.md as a regime change", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    writeFileSync(fx.goalFile, readFileSync(fx.goalFile, "utf8").replace("value: 250", "value: 400"));
    const report = auditGoal(fx.location, "g-fast");
    expect(report.state).toBe("needs_reapproval");
    expect(report.regime_changes).toEqual(["goal.md changed since approval"]);
    expect(report.problems).toEqual([]);
  });

  it("stops on a tampered, missing or malformed metric lock", () => {
    const tampered = setupGoal();
    lockGoal(tampered.location, "g-fast", "human:dev");
    const file = lockFile(tampered.location.dir, "g-fast", "m-p95");
    const lock = JSON.parse(readFileSync(file, "utf8")) as { command: string[] };
    lock.command = ["sh", "-c", "echo 1"];
    writeFileSync(file, JSON.stringify(lock));
    const report = auditGoal(tampered.location, "g-fast");
    expect(report.problems).toEqual(["metric lock tampered: m-p95"]);
    expect(report.locked).toBeNull();

    const missing = setupGoal();
    lockGoal(missing.location, "g-fast", "human:dev");
    rmSync(lockFile(missing.location.dir, "g-fast", "m-errors"));
    expect(auditGoal(missing.location, "g-fast").problems).toEqual(["metric lock missing: m-errors"]);

    const malformed = setupGoal();
    lockGoal(malformed.location, "g-fast", "human:dev");
    writeFileSync(lockFile(malformed.location.dir, "g-fast", "m-p95"), "{");
    expect(auditGoal(malformed.location, "g-fast").problems[0]).toMatch(/lock for m-p95 is not valid JSON/);
  });

  it("stops on a tampered goal lock", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    const file = goalLockFile(fx.location.dir, "g-fast");
    const lock = JSON.parse(readFileSync(file, "utf8")) as { semantic: { target: { value: number } } };
    lock.semantic.target.value = 1000;
    writeFileSync(file, JSON.stringify(lock));
    expect(auditGoal(fx.location, "g-fast").problems).toEqual(["goal lock tampered: g-fast"]);
  });

  it("treats a changed proposal as a regime change", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    proposeMetric(
      fx.ledger,
      fx.location.dir,
      { metric_id: "m-p95", command: ["sh", "bench/p95-v2.sh"], unit: "ms", watched_paths: ["bench/p95.sh"], image: null },
      "human:dev",
    );
    expect(auditGoal(fx.location, "g-fast").regime_changes).toEqual(["metric m-p95 definition changed"]);
  });

  it("treats a change to a watched path as a regime change, committed or not", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    writeFileSync(join(fx.repo, "bench", "errors.sh"), "echo 0.5\n");
    expect(auditGoal(fx.location, "g-fast").regime_changes).toEqual([]);
    writeFileSync(join(fx.repo, "bench", "p95.sh"), "echo 100\n");
    expect(auditGoal(fx.location, "g-fast").regime_changes).toEqual(["watched path changed: bench/p95.sh (m-p95)"]);
  });

  it("counts wall time from the first approval using the locked budget", () => {
    const fx = setupGoal();
    const approval = lockGoal(fx.location, "g-fast", "human:dev");
    const at = (hours: number): Date => new Date(Date.parse(approval.first_approved_at) + hours * 3_600_000);
    expect(auditGoal(fx.location, "g-fast", at(1)).wall_time_exceeded).toBe(false);
    writeFileSync(fx.goalFile, readFileSync(fx.goalFile, "utf8").replace("wall_time: 72h", "wall_time: 999d"));
    const late = auditGoal(fx.location, "g-fast", at(73));
    expect(late.wall_time_exceeded).toBe(true);
    expect(late.regime_changes).toEqual(["goal.md changed since approval"]);
  });
});
