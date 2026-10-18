import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { auditGoal } from "../../src/goal/audit.js";
import { goalTemplate } from "../../src/goal/goal-file.js";
import { goalLockFile, lockGoal } from "../../src/goal/goal-lock.js";
import { lockFile, proposeMetric } from "../../src/goal/metrics.js";
import { raiseWallTime } from "../../src/goal/wall-time.js";
import { approveLegacy, markStale, setupGoal, writeBands } from "../helpers/goal.js";

describe("auditGoal", () => {
  it("reports a draft that is missing a metric proposal", () => {
    const fx = setupGoal({ guardrails: ["m-unknown"] });
    const report = auditGoal(fx.location, "g-fast");
    expect(report.state).toBe("draft");
    expect(report.problems).toEqual(["metric m-unknown has no proposal; run omf metric propose m-unknown"]);
  });

  it("lists template placeholders apart from the problems, and keeps the existing check", () => {
    const fx = setupGoal();
    writeFileSync(fx.goalFile, goalTemplate("g-fast"));
    const report = auditGoal(fx.location, "g-fast");
    expect(report.state).toBe("draft");
    expect(report.problems).toEqual(["metric m-replace-me has no proposal; run omf metric propose m-replace-me"]);
    expect(report.placeholders[0]).toMatch(/^metric id m-replace-me is a placeholder/);
    expect(report.placeholders.length).toBeGreaterThan(1);
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
    expect(report.state).toBe("tampered");

    const missing = setupGoal();
    lockGoal(missing.location, "g-fast", "human:dev");
    rmSync(lockFile(missing.location.dir, "g-fast", "m-errors"));
    const gone = auditGoal(missing.location, "g-fast");
    expect(gone.problems).toEqual(["metric lock missing: m-errors"]);
    expect(gone.state).toBe("tampered");

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
    const report = auditGoal(fx.location, "g-fast");
    expect(report.problems).toEqual(["goal lock tampered: g-fast"]);
    expect(report.state).toBe("tampered");
  });

  it("reports tampered, not needs_reapproval, when a lock is edited and goal.md also changed", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    const file = lockFile(fx.location.dir, "g-fast", "m-p95");
    const lock = JSON.parse(readFileSync(file, "utf8")) as { command: string[] };
    lock.command = ["sh", "-c", "echo 1"];
    writeFileSync(file, JSON.stringify(lock));
    writeFileSync(fx.goalFile, readFileSync(fx.goalFile, "utf8").replace("value: 250", "value: 400"));
    const report = auditGoal(fx.location, "g-fast");
    expect(report.regime_changes).toEqual(["goal.md changed since approval"]);
    expect(report.problems).toEqual(["metric lock tampered: m-p95"]);
    expect(report.state).toBe("tampered");
  });

  it("checks a metric lock against the ledger event of its own regime only", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    // An approval that crashed after writing a lock event never got its goal.approved: regime 2 does not exist.
    fx.ledger.append({
      actor: "human:dev",
      type: "metric.locked",
      payload: { goal_id: "g-fast", metric_id: "m-p95", sha256: "f".repeat(64), regime: 2 },
    });
    const report = auditGoal(fx.location, "g-fast");
    expect(report.problems).toEqual([]);
    expect(report.state).toBe("approved");
  });

  it("treats a changed proposal as a regime change", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    proposeMetric(
      fx.ledger,
      fx.location.dir,
      {
        metric_id: "m-p95",
        command: ["sh", "bench/p95-v2.sh"],
        unit: "ms",
        watched_paths: ["bench/p95.sh"],
        image: null,
      },
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

describe("auditGoal bands", () => {
  it("treats an edit to a bands file after approval as a regime change, and re-approval clears it", () => {
    const fx = setupGoal();
    const file = writeBands(fx, "m-errors");
    lockGoal(fx.location, "g-fast", "human:dev");
    expect(auditGoal(fx.location, "g-fast")).toMatchObject({ state: "approved", regime_changes: [] });
    writeFileSync(file, readFileSync(file, "utf8").replace("propose", "log"));
    const changed = auditGoal(fx.location, "g-fast");
    expect(changed.state).toBe("needs_reapproval");
    expect(changed.regime_changes).toEqual(["bands changed: m-errors"]);
    expect(changed.problems).toEqual([]);
    lockGoal(fx.location, "g-fast", "human:dev");
    expect(auditGoal(fx.location, "g-fast")).toMatchObject({ state: "approved", regime_changes: [] });
  });

  it("treats a created bands file and a deleted one as regime changes", () => {
    const created = setupGoal();
    lockGoal(created.location, "g-fast", "human:dev");
    writeBands(created, "m-errors");
    expect(auditGoal(created.location, "g-fast").regime_changes).toEqual(["bands changed: m-errors"]);

    const deleted = setupGoal();
    const file = writeBands(deleted, "m-errors");
    lockGoal(deleted.location, "g-fast", "human:dev");
    rmSync(file);
    expect(auditGoal(deleted.location, "g-fast").regime_changes).toEqual(["bands changed: m-errors"]);
  });

  it("lists every metric whose bands changed, sorted, and counts an unreadable file as changed", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    writeBands(fx, "m-p95");
    writeFileSync(writeBands(fx, "m-errors"), "metric: [\n");
    expect(auditGoal(fx.location, "g-fast").regime_changes).toEqual(["bands changed: m-errors, m-p95"]);
  });

  it("stops on a goal lock whose bands map was edited without the ledger", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    const file = goalLockFile(fx.location.dir, "g-fast");
    const lock = JSON.parse(readFileSync(file, "utf8")) as { bands: Record<string, string | null> };
    lock.bands["m-errors"] = "a".repeat(64);
    writeFileSync(file, JSON.stringify(lock));
    const report = auditGoal(fx.location, "g-fast");
    expect(report.problems).toEqual(["goal lock bands tampered"]);
    expect(report.state).toBe("tampered");
    expect(report.locked).toBeNull();
  });

  it("stops on a goal lock whose bands map was removed", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    const file = goalLockFile(fx.location.dir, "g-fast");
    const lock = JSON.parse(readFileSync(file, "utf8")) as { bands?: unknown };
    delete lock.bands;
    writeFileSync(file, JSON.stringify(lock));
    expect(auditGoal(fx.location, "g-fast").problems).toEqual(["goal lock bands tampered"]);
  });

  it("does not flag an approval from before bands were locked", () => {
    const fx = setupGoal();
    approveLegacy(fx);
    writeBands(fx, "m-errors");
    const report = auditGoal(fx.location, "g-fast");
    expect(report).toMatchObject({
      state: "approved",
      problems: [],
      regime_changes: [],
      approval: { bands_sha256: null, wall_time: null },
    });
    expect(report.wall_time_exceeded).toBe(false);
  });
});

describe("auditGoal wall time and stale mark", () => {
  const at = (first: string, hours: number): Date => new Date(Date.parse(first) + hours * 3_600_000);

  it("counts wall time from the ledger even when the goal lock is gone", () => {
    const fx = setupGoal();
    const approval = lockGoal(fx.location, "g-fast", "human:dev");
    rmSync(goalLockFile(fx.location.dir, "g-fast"));
    expect(auditGoal(fx.location, "g-fast", at(approval.first_approved_at, 1)).wall_time_exceeded).toBe(false);
    const late = auditGoal(fx.location, "g-fast", at(approval.first_approved_at, 73));
    expect(late.problems).toEqual(["goal lock missing: g-fast"]);
    expect(late.wall_time_exceeded).toBe(true);
  });

  it("extends the limit by the wall time a person raised since the approval", () => {
    const fx = setupGoal();
    const approval = lockGoal(fx.location, "g-fast", "human:dev");
    raiseWallTime(fx.ledger, "g-fast", "24h", "human:dev");
    expect(auditGoal(fx.location, "g-fast", at(approval.first_approved_at, 73)).wall_time_exceeded).toBe(false);
    expect(auditGoal(fx.location, "g-fast", at(approval.first_approved_at, 95)).wall_time_exceeded).toBe(false);
    expect(auditGoal(fx.location, "g-fast", at(approval.first_approved_at, 97)).wall_time_exceeded).toBe(true);
  });

  it("treats a goal marked stale as a regime change until the next approval", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    markStale(fx);
    const report = auditGoal(fx.location, "g-fast");
    expect(report.state).toBe("needs_reapproval");
    expect(report.regime_changes).toEqual(["goal marked stale (age)"]);
    expect(report.problems).toEqual([]);
    lockGoal(fx.location, "g-fast", "human:dev");
    expect(auditGoal(fx.location, "g-fast")).toMatchObject({ state: "approved", regime_changes: [] });
  });
});
