import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { budgetState, declareBudget } from "../../src/core/budget.js";
import { Ledger } from "../../src/core/ledger.js";
import { bandsLockInfo } from "../../src/goal/bands.js";
import { semanticHash } from "../../src/goal/goal-file.js";
import {
  ApprovalError,
  GoalLockError,
  goalLockFile,
  latestApproval,
  lockGoal,
  readGoalLock,
} from "../../src/goal/goal-lock.js";
import { lockFile, metricSha256, readLock, readProposal } from "../../src/goal/metrics.js";
import { setupGoal, writeBands } from "../helpers/goal.js";
import { makeTempDir } from "../helpers/tmp.js";

describe("lockGoal", () => {
  it("locks the goal and its metrics as regime 1 and declares the rounds budget", () => {
    const fx = setupGoal();
    const approval = lockGoal(fx.location, "g-fast", "human:dev");
    expect(approval).toMatchObject({ regime: 1, metrics: ["m-p95", "m-errors"], approved_by: "human:dev" });
    expect(approval.first_approved_at).toBe(approval.approved_at);

    const goalLock = readGoalLock(fx.location.dir, "g-fast");
    expect(goalLock?.semantic_sha256).toBe(approval.semantic_sha256);
    expect(semanticHash(goalLock!.semantic)).toBe(approval.semantic_sha256);
    expect((statSync(goalLockFile(fx.location.dir, "g-fast")).mode & 0o777).toString(8)).toBe("600");

    const p95 = readLock(fx.location.dir, "g-fast", "m-p95");
    expect(p95).toMatchObject({
      goal_id: "g-fast",
      regime: 1,
      approved_by: "human:dev",
      command: ["sh", "bench/p95.sh"],
    });
    expect(p95?.sha256).toBe(metricSha256(readProposal(fx.location.dir, "m-p95")!));
    expect((statSync(lockFile(fx.location.dir, "g-fast", "m-p95")).mode & 0o777).toString(8)).toBe("600");

    const types = new Ledger(fx.location.dir).readVerified().map((e) => e.type);
    expect(types.slice(-4)).toEqual(["metric.locked", "metric.locked", "goal.approved", "budget.declared"]);
    expect(budgetState(fx.ledger, "g-fast", "rounds")?.remaining).toBe(10);
  });

  it("starts a new regime on each lock and declares the budget only once", () => {
    const fx = setupGoal();
    const first = lockGoal(fx.location, "g-fast", "human:dev");
    const second = lockGoal(fx.location, "g-fast", "human:dev");
    expect(second.regime).toBe(2);
    expect(second.first_approved_at).toBe(first.approved_at);
    expect(readLock(fx.location.dir, "g-fast", "m-p95")?.regime).toBe(2);
    const declared = new Ledger(fx.location.dir).readVerified().filter((e) => e.type === "budget.declared");
    expect(declared).toHaveLength(1);
  });

  it("refuses agents, missing proposals and a target unit that does not match its metric", () => {
    expect(() => lockGoal(setupGoal().location, "g-fast", "agent:claude")).toThrow(ApprovalError);

    const missing = setupGoal({ guardrails: ["m-unknown"] });
    expect(() => lockGoal(missing.location, "g-fast", "human:dev")).toThrow(/m-unknown has no proposal/);

    const unit = setupGoal();
    writeFileSync(unit.goalFile, readFileSync(unit.goalFile, "utf8").replace("unit: ms", "unit: s"));
    expect(() => lockGoal(unit.location, "g-fast", "human:dev")).toThrow(
      /target unit s does not match metric m-p95 unit ms/,
    );
    expect(latestApproval(new Ledger(unit.location.dir).readVerified(), "g-fast")).toBeNull();
  });

  it("refuses while a watched path has uncommitted changes", () => {
    const fx = setupGoal();
    writeFileSync(join(fx.repo, "bench", "p95.sh"), "echo 100\n");
    expect(() => lockGoal(fx.location, "g-fast", "human:dev")).toThrow(
      "commit or revert changes to watched paths before approving: bench/p95.sh",
    );
    expect(latestApproval(new Ledger(fx.location.dir).readVerified(), "g-fast")).toBeNull();
  });

  it("stops on a goal.approved event written by a non-person", () => {
    const fx = setupGoal();
    fx.ledger.append({
      actor: "agent:claude",
      type: "goal.approved",
      payload: {
        goal_id: "g-fast",
        regime: 1,
        semantic_sha256: "a".repeat(64),
        head_commit: "b".repeat(40),
        metrics: ["m-p95"],
      },
    });
    expect(() => latestApproval(fx.ledger.readVerified(), "g-fast")).toThrow(/goal.approved by agent:claude/);
  });

  it("refuses re-approval while goal.md changes the rounds budget, which only J8 may raise", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    writeFileSync(fx.goalFile, readFileSync(fx.goalFile, "utf8").replace(/rounds: 10\b/, "rounds: 20"));
    expect(() => lockGoal(fx.location, "g-fast", "human:dev")).toThrow(/rounds.*J8/);
    expect(budgetState(fx.ledger, "g-fast", "rounds")?.remaining).toBe(10);
  });

  it("refuses a first approval when rounds were declared before J1 and differ from goal.md", () => {
    const fx = setupGoal();
    declareBudget(fx.ledger, "g-fast", "rounds", 1000, "human:dev");
    expect(() => lockGoal(fx.location, "g-fast", "human:dev")).toThrow(/rounds.*J8/);
    expect(latestApproval(fx.ledger.readVerified(), "g-fast")).toBeNull();
  });

  it("refuses re-approval while goal.md changes the wall time", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    writeFileSync(fx.goalFile, readFileSync(fx.goalFile, "utf8").replace(/wall_time: \S+/, "wall_time: 999d"));
    expect(() => lockGoal(fx.location, "g-fast", "human:dev")).toThrow(/wall.time.*J8/);
  });
});

const GOAL_LOCK_MODULE = resolve("dist/goal/goal-lock.js");
const PATHS_MODULE = resolve("dist/core/paths.js");

/**
 * Child: waits for the go file, then approves the goal as `actor`. Its clock sleeps 300 ms the first time
 * lockGoal reads it, which happens after the approve lock is held, so the winner keeps the lock long enough
 * for the other process to have taken its snapshot of the regime and to be waiting for the lock.
 */
const APPROVER = `
const { lockGoal } = await import(process.argv[1]);
const { resolveProject } = await import(process.argv[2]);
const { existsSync, writeFileSync } = await import("node:fs");
const [repo, omfHome, goalId, actor, ready, go] = process.argv.slice(3);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const location = resolveProject(repo, { OMF_HOME: omfHome });
writeFileSync(ready, "");
while (!existsSync(go)) sleep(2);
let first = true;
const now = () => {
  if (first) {
    first = false;
    sleep(300);
  }
  return new Date();
};
try {
  const approval = lockGoal(location, goalId, actor, now);
  console.log(JSON.stringify({ ok: true, actor, regime: approval.regime }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, actor, name: err.name, message: err.message }));
}
`;

interface Outcome {
  ok: boolean;
  actor: string;
  regime?: number;
  name?: string;
  message?: string;
}

async function waitFor(path: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (existsSync(path)) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

function startApprover(fx: ReturnType<typeof setupGoal>, actor: string, ready: string, go: string): Promise<Outcome> {
  return new Promise((done, fail) => {
    const args = [GOAL_LOCK_MODULE, PATHS_MODULE, fx.repo, join(fx.home, ".omf"), "g-fast", actor, ready, go];
    const child = spawn(process.execPath, ["--input-type=module", "-e", APPROVER, ...args], {
      env: { ...process.env, HOME: fx.home },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("error", fail);
    child.on("close", (code) => {
      if (code !== 0) fail(new Error(`approver ${actor} exited ${code}: ${out}`));
      else done(JSON.parse(out.trim().split("\n").at(-1) ?? "") as Outcome);
    });
  });
}

describe("lockGoal under concurrency", () => {
  it("lets exactly one of two racing approvals through and writes nothing for the other", async () => {
    const fx = setupGoal();
    const sync = makeTempDir("omf-race-");
    const go = join(sync, "go");
    const readyA = join(sync, "ready-a");
    const readyB = join(sync, "ready-b");
    const runs = [startApprover(fx, "human:a", readyA, go), startApprover(fx, "human:b", readyB, go)];
    await Promise.all([waitFor(readyA), waitFor(readyB)]);
    writeFileSync(go, "");
    const outcomes = await Promise.all(runs);

    const won = outcomes.filter((o) => o.ok);
    const lost = outcomes.filter((o) => !o.ok);
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ name: "ApprovalError" });
    expect(lost[0]?.message).toMatch(/another approval of g-fast ran concurrently/);
    const winner = won[0]!.actor;

    const events = new Ledger(fx.location.dir).readVerified();
    expect(events.filter((e) => e.type === "goal.approved")).toHaveLength(1);
    expect(events.filter((e) => e.type === "budget.declared")).toHaveLength(1);
    expect(
      events.filter((e) => e.type === "metric.locked").map((e) => [e.payload.metric_id, e.payload.regime, e.actor]),
    ).toEqual([
      ["m-p95", 1, winner],
      ["m-errors", 1, winner],
    ]);
    expect(readGoalLock(fx.location.dir, "g-fast")).toMatchObject({ regime: 1, approved_by: winner });
    expect(readLock(fx.location.dir, "g-fast", "m-p95")).toMatchObject({ regime: 1, approved_by: winner });
    expect(existsSync(join(fx.location.dir, "vault", "metrics", "g-fast", "approve.lock"))).toBe(false);
  });

  it("reclaims an approve.lock left by a process that died, and releases it when done", () => {
    const fx = setupGoal();
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    const lockPath = join(fx.location.dir, "vault", "metrics", "g-fast", "approve.lock");
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: dead, start_time: null, acquired_at: "2026-10-12T00:00:00.000Z" }));
    expect(lockGoal(fx.location, "g-fast", "human:dev").regime).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("lockGoal bands and wall time", () => {
  it("records the bands hash and the wall time in the lock and in the approval event", () => {
    const fx = setupGoal();
    writeBands(fx, "m-errors");
    const approval = lockGoal(fx.location, "g-fast", "human:dev");
    const info = bandsLockInfo(fx.location.dir, "g-fast", ["m-p95", "m-errors"]);
    expect(info.map["m-p95"]).toBeNull();
    expect(info.map["m-errors"]).toMatch(/^[0-9a-f]{64}$/);
    expect(approval).toMatchObject({ bands_sha256: info.sha256, wall_time: "72h" });
    expect(readGoalLock(fx.location.dir, "g-fast")?.bands).toEqual(info.map);
    expect(latestApproval(new Ledger(fx.location.dir).readVerified(), "g-fast")).toMatchObject({
      bands_sha256: info.sha256,
      wall_time: "72h",
    });
  });

  it("locks null for every metric when there are no bands files", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    expect(readGoalLock(fx.location.dir, "g-fast")?.bands).toEqual({ "m-p95": null, "m-errors": null });
  });

  it("refuses re-approval that changes the wall time using the ledger, even when the lock file is gone", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    rmSync(goalLockFile(fx.location.dir, "g-fast"));
    writeFileSync(fx.goalFile, readFileSync(fx.goalFile, "utf8").replace(/wall_time: \S+/, "wall_time: 999d"));
    expect(() => lockGoal(fx.location, "g-fast", "human:dev")).toThrow(/wall.time.*J8/);
  });

  it("rejects a goal lock whose bands hash is not 64 hex", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    const file = goalLockFile(fx.location.dir, "g-fast");
    const lock = JSON.parse(readFileSync(file, "utf8")) as { bands: Record<string, string | null> };
    lock.bands["m-p95"] = "xyz";
    writeFileSync(file, JSON.stringify(lock));
    expect(() => readGoalLock(fx.location.dir, "g-fast")).toThrow(GoalLockError);
    expect(() => readGoalLock(fx.location.dir, "g-fast")).toThrow(/goal lock is invalid/);
  });

  it("reads an approval written before bands and wall time were recorded as null", () => {
    const fx = setupGoal();
    fx.ledger.append({
      actor: "human:dev",
      type: "goal.approved",
      payload: {
        goal_id: "g-fast",
        regime: 1,
        semantic_sha256: "a".repeat(64),
        head_commit: "b".repeat(40),
        metrics: ["m-p95"],
      },
    });
    expect(latestApproval(fx.ledger.readVerified(), "g-fast")).toMatchObject({ bands_sha256: null, wall_time: null });
  });

  it("stops on an approval with a malformed bands hash or wall time", () => {
    const base = {
      goal_id: "g-fast",
      regime: 1,
      semantic_sha256: "a".repeat(64),
      head_commit: "b".repeat(40),
      metrics: ["m-p95"],
    };
    const hash = setupGoal();
    hash.ledger.append({ actor: "human:dev", type: "goal.approved", payload: { ...base, bands_sha256: "nope" } });
    expect(() => latestApproval(hash.ledger.readVerified(), "g-fast")).toThrow(/malformed bands_sha256/);

    const wall = setupGoal();
    wall.ledger.append({ actor: "human:dev", type: "goal.approved", payload: { ...base, wall_time: "soon" } });
    expect(() => latestApproval(wall.ledger.readVerified(), "g-fast")).toThrow(/malformed wall_time/);
  });
});
