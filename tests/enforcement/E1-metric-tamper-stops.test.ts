// covers: F2.metric-lock-before-measure
// covers: S11.5.governance-unreadable-stops
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/core/ledger.js";
import { approveGoal } from "../../src/goal/approve.js";
import { auditGoal } from "../../src/goal/audit.js";
import { goalLockFile } from "../../src/goal/goal-lock.js";
import { type MetricLock, lockFile, metricSha256, proposeMetric } from "../../src/goal/metrics.js";
import { omf } from "../helpers/cli.js";
import { setupGoal, writeBands } from "../helpers/goal.js";
import { commitAll } from "../helpers/tmp.js";

// Spec §4.6: tampering with metric code is a regime change that J1 must approve; a metric the person did
// not approve is never measured; a lock that does not match the ledger stops the measurement.
const measured = (dir: string): number =>
  new Ledger(dir).readVerified().filter((e) => e.type === "metric.measured").length;

describe("E1 metric-tamper-stops", () => {
  it("never measures a metric that J1 did not approve", () => {
    const fx = setupGoal();
    const result = omf(["goal", "measure", "g-fast", "--runner", "host"], fx.repo, fx.home);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("is not approved (J1)");
    expect(measured(fx.location.dir)).toBe(0);
  });

  it("stops when a metric lock was edited", () => {
    const fx = setupGoal();
    approveGoal(fx.location, "g-fast", "human:dev");
    const file = lockFile(fx.location.dir, "g-fast", "m-p95");
    const lock = JSON.parse(readFileSync(file, "utf8")) as { command: string[] };
    lock.command = ["sh", "-c", "echo 1"];
    writeFileSync(file, JSON.stringify(lock));
    const result = omf(["goal", "measure", "g-fast", "--runner", "host"], fx.repo, fx.home);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("metric lock tampered: m-p95");
    expect(measured(fx.location.dir)).toBe(0);
  });

  it("stops when a metric lock was edited and its own hash recomputed", () => {
    const fx = setupGoal();
    approveGoal(fx.location, "g-fast", "human:dev");
    const file = lockFile(fx.location.dir, "g-fast", "m-p95");
    const lock = JSON.parse(readFileSync(file, "utf8")) as MetricLock;
    lock.command = ["sh", "-c", "echo 1"];
    lock.sha256 = metricSha256(lock);
    writeFileSync(file, JSON.stringify(lock));
    const result = omf(["goal", "measure", "g-fast", "--runner", "host"], fx.repo, fx.home);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("metric lock tampered: m-p95");
    expect(measured(fx.location.dir)).toBe(0);
  });

  it("never runs a re-proposed definition of an approved metric", () => {
    const fx = setupGoal();
    approveGoal(fx.location, "g-fast", "human:dev");
    proposeMetric(
      fx.ledger,
      fx.location.dir,
      { metric_id: "m-p95", command: ["sh", "-c", "echo 1"], unit: "ms", watched_paths: ["bench/p95.sh"], image: null },
      "human:dev",
    );
    const result = omf(["goal", "measure", "g-fast", "--runner", "host", "--json"], fx.repo, fx.home);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as { target: { measured: number }; regime_changes: string[] };
    expect(report.target.measured).toBe(312);
    expect(report.regime_changes).toContain("metric m-p95 definition changed");
  });

  it("labels a change to the metric's code as a regime change until J1 approves again", () => {
    const fx = setupGoal();
    approveGoal(fx.location, "g-fast", "human:dev");
    writeFileSync(join(fx.repo, "bench", "p95.sh"), "echo 100\n");
    commitAll(fx.repo, "faster benchmark");
    const changed = omf(["goal", "measure", "g-fast", "--runner", "host"], fx.repo, fx.home);
    expect(changed.code).toBe(1);
    expect(changed.stdout).toContain("needs re-approval (J1)");
    expect(changed.stdout).toContain("watched path changed: bench/p95.sh (m-p95)");
    expect(new Ledger(fx.location.dir).readVerified().some((e) => e.type === "goal.regime_changed")).toBe(true);
    expect(auditGoal(fx.location, "g-fast").state).toBe("needs_reapproval");

    expect(approveGoal(fx.location, "g-fast", "human:dev").approval.regime).toBe(2);
    expect(omf(["goal", "measure", "g-fast", "--runner", "host"], fx.repo, fx.home).code).toBe(0);
  });

  it("keeps measuring against the locked target when goal.md is edited", () => {
    const fx = setupGoal();
    approveGoal(fx.location, "g-fast", "human:dev");
    writeFileSync(fx.goalFile, readFileSync(fx.goalFile, "utf8").replace("value: 250", "value: 400"));
    const result = omf(["goal", "measure", "g-fast", "--runner", "host", "--json"], fx.repo, fx.home);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as { target: { value: number }; needs_reapproval: boolean };
    expect(report.target.value).toBe(250);
    expect(report.needs_reapproval).toBe(true);
  });

  it("labels an edit to a bands file as a regime change until J1 approves again", () => {
    const fx = setupGoal();
    const file = writeBands(fx, "m-errors");
    approveGoal(fx.location, "g-fast", "human:dev");
    writeFileSync(file, readFileSync(file, "utf8").replace("propose", "log"));
    const changed = omf(["goal", "measure", "g-fast", "--runner", "host"], fx.repo, fx.home);
    expect(changed.code).toBe(1);
    expect(changed.stdout).toContain("needs re-approval (J1)");
    expect(changed.stdout).toContain("bands changed: m-errors");

    expect(approveGoal(fx.location, "g-fast", "human:dev").approval.regime).toBe(2);
    expect(omf(["goal", "measure", "g-fast", "--runner", "host"], fx.repo, fx.home).code).toBe(0);
  });

  it("stops when the bands recorded in the goal lock were edited", () => {
    const fx = setupGoal();
    approveGoal(fx.location, "g-fast", "human:dev");
    const file = goalLockFile(fx.location.dir, "g-fast");
    const lock = JSON.parse(readFileSync(file, "utf8")) as { bands: Record<string, string | null> };
    lock.bands["m-errors"] = "a".repeat(64);
    writeFileSync(file, JSON.stringify(lock));
    const result = omf(["goal", "measure", "g-fast", "--runner", "host"], fx.repo, fx.home);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("goal lock bands tampered");
    expect(measured(fx.location.dir)).toBe(0);
  });
});
