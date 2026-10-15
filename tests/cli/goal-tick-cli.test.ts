import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { budgetState, consumeBudget } from "../../src/core/budget.js";
import { acquireLock, releaseLock } from "../../src/core/lock.js";
import { escalate, terminate } from "../../src/goal/lifecycle.js";
import { lockFile } from "../../src/goal/metrics.js";
import { tickLockFile } from "../../src/goal/tick-lock.js";
import { omf, omfAsync } from "../helpers/cli.js";
import { type GoalFixture, setupGoal } from "../helpers/goal.js";
import { GOAL, MEASURED, TARGET, TITLES, setPlan, setupLoopGoal, stubCalls, waitFor } from "../helpers/tick-loop.js";

const TICK = ["goal", "tick", GOAL, "--runner", "host"];
const tick = (fx: GoalFixture, extra: string[] = []) => omf([...TICK, ...extra], fx.repo, fx.home);
const eventCount = (fx: GoalFixture): number => fx.ledger.readVerified().length;

/** D29: a tick runs under cron and CI whose logs other agents may read, so no value, target or model title is printed. */
function expectQuiet(...results: { stdout: string; stderr: string }[]): void {
  for (const result of results) {
    for (const secret of [MEASURED, TARGET, ...TITLES]) {
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
    }
  }
}

describe("omf goal tick: a codex implementer in the config", () => {
  it("still ticks, because the config accepts it and only the implementer station refuses", () => {
    const fx = setupLoopGoal();
    const file = join(fx.location.dir, "config.toml");
    const text = readFileSync(file, "utf8");
    const swapped = text.replace('implementer = { vendor = "claude" }', 'implementer = { vendor = "codex" }');
    expect(swapped).not.toBe(text);
    writeFileSync(file, swapped);
    const result = tick(fx);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^goal g-fast: tick t-\S+ continue \(dispatched\)$/m);
  });
});

describe("omf goal tick: output and exit codes", () => {
  it("dispatches, prints ids and veto commands but no values or titles, warns about the host runner, exits 0", () => {
    const fx = setupLoopGoal();
    const result = tick(fx);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^goal g-fast: tick t-\S+ continue \(dispatched\)$/m);
    expect(result.stdout).toMatch(/omf veto w-[0-9a-f]{12}/);
    expect(result.stderr).toContain("warning: ticking on the host without isolation (--runner host)");
    expectQuiet(result);
  });

  it("--json prints the tick result without titles", () => {
    const fx = setupLoopGoal();
    const result = tick(fx, ["--json"]);
    expect(result.code).toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown> & { created: Record<string, unknown>[] };
    expect(json).toMatchObject({
      goal_id: GOAL,
      status: "continue",
      outcome: "dispatched",
      reconciled: true,
      awaiting_approval: [],
    });
    expect(json.created).toHaveLength(1);
    expect(Object.keys(json.created[0] ?? {}).sort()).toEqual(["risk", "state", "work_id"]);
    expect(String(json.report)).toMatch(/-tick\.md$/);
    expectQuiet(result);
  });

  it("exits 1 and names `omf work approve <id>` when an item awaits approval", () => {
    const fx = setupLoopGoal();
    setPlan(fx, { mode: "ok", count: 1, paths: [".github/workflows/ci.yml"] });
    const result = tick(fx);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("continue (dispatched)");
    expect(result.stdout).toMatch(/awaiting approval:\n\s+- w-[0-9a-f]{12}/);
    expect(result.stdout).toMatch(/omf work approve w-[0-9a-f]{12}/);
    expectQuiet(result);
  });

  it("exits 1 for a goal that was never approved (J1) and says how to approve it", () => {
    const fx = setupGoal();
    const result = tick(fx);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("blocked_on_user");
    expect(result.stdout).toContain(`omf goal approve ${GOAL}`);
    expectQuiet(result);
  });

  it("exits 1 when the audit stopped the tick (outcome stopped)", () => {
    const fx = setupLoopGoal();
    const file = lockFile(fx.location.dir, GOAL, "m-p95");
    const lock = JSON.parse(readFileSync(file, "utf8")) as { command: string[] };
    lock.command = ["sh", "-c", "echo 1"];
    writeFileSync(file, JSON.stringify(lock));
    const result = tick(fx);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/\(stopped/);
    expect(stubCalls(fx)).toBe(0);
    expectQuiet(result);
  });

  it("exits 1 for a goal parked for a person and writes nothing", () => {
    const fx = setupLoopGoal();
    escalate(fx.ledger, GOAL, "t-20261012T090000Z-0000", "no_progress", null);
    const before = eventCount(fx);
    const result = tick(fx);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("stopped_until_resumed");
    expect(result.stdout).toContain(`omf goal resume ${GOAL}`);
    expect(eventCount(fx)).toBe(before);
    expectQuiet(result);
  });

  it("exits 0 for a goal that already finished and 1 for a cancelled one", () => {
    const finished = setupLoopGoal();
    terminate(finished.ledger, GOAL, "finish", null, "success");
    const done = tick(finished);
    expect(done.code).toBe(0);
    expect(done.stdout).toContain("already_final");

    const cancelled = setupLoopGoal();
    terminate(cancelled.ledger, GOAL, "cancelled", null, "cancelled_by_user", "human:dev");
    const gone = tick(cancelled);
    expect(gone.code).toBe(1);
    expect(gone.stdout).toContain("already_final");
    expectQuiet(done, gone);
  });

  it("exits 2 for an unknown goal, a missing config.toml, an unknown runner and a held tick lock", () => {
    const fx = setupLoopGoal();
    const unknown = omf(["goal", "tick", "g-nope", "--runner", "host"], fx.repo, fx.home);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("goal g-nope not found");

    const runner = tick(fx, ["--runner", "podman"]);
    expect(runner.code).toBe(2);
    expect(runner.stderr).toContain("unknown runner podman; use docker or host");

    const lock = tickLockFile(fx.location, GOAL);
    acquireLock(lock);
    const before = eventCount(fx);
    try {
      const held = tick(fx);
      expect(held.code).toBe(2);
      expect(held.stderr).toContain("a tick is running; retry");
      expect(eventCount(fx)).toBe(before);
    } finally {
      releaseLock(lock);
    }

    rmSync(join(fx.location.dir, "config.toml"));
    const config = tick(fx);
    expect(config.code).toBe(2);
    expect(config.stderr).toContain("config.toml missing; run omf init");
    expect(eventCount(fx)).toBe(before);
  });

  it("reclaims a tick.lock whose owner died", () => {
    const fx = setupLoopGoal();
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    if (dead === undefined) throw new Error("could not start a child process");
    const lock = tickLockFile(fx.location, GOAL);
    writeFileSync(lock, JSON.stringify({ pid: dead, start_time: null, acquired_at: new Date().toISOString() }));
    expect(tick(fx).code).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  it("a project with no [reconciler] section and no credentials fails with auth_missing and exits 1", () => {
    const fx = setupLoopGoal({ stub: false });
    const result = tick(fx, ["--json"]);
    expect(result.code).toBe(1);
    const json = JSON.parse(result.stdout) as { outcome: string; signatures: string[] };
    expect(json.outcome).toBe("stopped");
    expect(json.signatures.some((s) => s.includes("auth_missing"))).toBe(true);
    const failed = fx.ledger.readVerified().filter((e) => e.type === "reconcile.failed");
    expect(failed.map((e) => e.payload.code)).toEqual(["auth_missing"]);
    expectQuiet(result);
  });
});

describe("omf goal tick: concurrency", () => {
  it("lets one of two simultaneous ticks run and exits the other with 2", async () => {
    const fx = setupLoopGoal();
    setPlan(fx, { mode: "ok", count: 1, delay_ms: 3000 });
    const first = omfAsync(TICK, fx.repo, fx.home);
    await waitFor(() => stubCalls(fx) >= 1); // the first tick is inside its model call, holding tick.lock
    const second = tick(fx);
    expect(second.code).toBe(2);
    expect(second.stderr).toContain("a tick is running; retry");
    expect((await first).code).toBe(0);
    expect(fx.ledger.readVerified().filter((e) => e.type === "goal.tick_started")).toHaveLength(1);
  });

  it("never lets two racing ticks both consume the last round", async () => {
    const fx = setupLoopGoal();
    consumeBudget(fx.ledger, GOAL, "rounds", 9); // one of ten left
    setPlan(fx, { mode: "ok", count: 1, delay_ms: 2000 });
    const results = await Promise.all([omfAsync(TICK, fx.repo, fx.home), omfAsync(TICK, fx.repo, fx.home)]);
    const codes = results.map((r) => r.code).sort();
    expect(codes[0]).toBe(0);
    expect([1, 2]).toContain(codes[1]);
    expect(budgetState(fx.ledger, GOAL, "rounds")).toMatchObject({ consumed: 10, remaining: 0 });
    expect(stubCalls(fx)).toBe(1);
    expectQuiet(...results);
  });
});
