import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { StateStore } from "../../src/adapters/state-markdown.js";
import { acquireLock, releaseLock } from "../../src/core/lock.js";
import { resumeGoal } from "../../src/goal/lifecycle.js";
import { runStateFromEvents } from "../../src/goal/run-state.js";
import { TickRunningError, tickLockFile } from "../../src/goal/tick-lock.js";
import { GOAL, runTick, setupLoopGoal, stubCalls } from "../helpers/tick-loop.js";

// vi.mock is file-wide and hoisted, so the switch lives in vi.hoisted.
const sabotage = vi.hoisted(() => ({ createWorkItem: false }));

vi.mock("../../src/adapters/state-markdown.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/adapters/state-markdown.js")>();
  return {
    ...actual,
    createMarkdownStore: (dir: string): StateStore => {
      const store = actual.createMarkdownStore(dir);
      return Object.create(store, {
        createWorkItem: {
          value: (...args: Parameters<StateStore["createWorkItem"]>) => {
            if (sabotage.createWorkItem) throw new Error("disk full");
            return store.createWorkItem(...args);
          },
        },
      }) as StateStore;
    },
  };
});

const INTERRUPTED = "dispatch|failed|tick.interrupted";

describe("unexpected failure inside a tick (D24)", () => {
  it("records goal.terminated(failed, internal_error), rethrows, and leaves a ledger that verifies and resumes", async () => {
    const fx = setupLoopGoal();
    sabotage.createWorkItem = true;
    try {
      await expect(runTick(fx)).rejects.toThrow("disk full");
    } finally {
      sabotage.createWorkItem = false;
    }

    const events = fx.ledger.readVerified();
    const started = events.find((e) => e.type === "goal.tick_started");
    const last = events.at(-1);
    expect(last).toMatchObject({
      type: "goal.terminated",
      actor: "omf",
      payload: { goal_id: GOAL, state: "failed", reason_code: "internal_error" },
    });
    expect(last?.payload.tick_id).toBe(started?.payload.tick_id);
    expect(fx.ledger.verify()).toMatchObject({ ok: true });
    expect(runStateFromEvents(events, GOAL).status).toBe("failed");
    expect(existsSync(tickLockFile(fx.location, GOAL))).toBe(false);

    expect(await runTick(fx)).toMatchObject({ status: "failed", outcome: "stopped_until_resumed" });
    resumeGoal(fx.ledger, GOAL, "human:dev");
    const next = await runTick(fx);
    expect(next.status).toBe("continue");
    // The failed tick was terminated on purpose, so it is not also counted as an interrupted one.
    expect(next.signatures).not.toContain(INTERRUPTED);
  });
});

describe("interrupted tick marker", () => {
  it("counts a predecessor that wrote goal.tick_started and never ended, once", async () => {
    const fx = setupLoopGoal();
    fx.ledger.append({
      actor: "omf",
      type: "goal.tick_started",
      payload: {
        goal_id: GOAL,
        tick_id: "t-20261012T080000Z-dead",
        regime: 1,
        runner: "host",
        config_sha256: "0".repeat(64),
      },
    });
    const first = await runTick(fx);
    expect(first.signatures).toContain(INTERRUPTED);
    expect(first.reason_code).toBe("tick.interrupted");
    const second = await runTick(fx);
    expect(second.signatures).not.toContain(INTERRUPTED);
    expect(second.reason_code).not.toBe("tick.interrupted");
  });
});

describe("tick.lock (D23)", () => {
  it("refuses a tick while another process holds the lock, and writes nothing", async () => {
    const fx = setupLoopGoal();
    const lock = tickLockFile(fx.location, GOAL);
    acquireLock(lock);
    const before = fx.ledger.readVerified().length;
    try {
      await expect(runTick(fx)).rejects.toBeInstanceOf(TickRunningError);
    } finally {
      releaseLock(lock);
    }
    expect(fx.ledger.readVerified().length).toBe(before);
    expect(stubCalls(fx)).toBe(0);
  });

  it("releases the lock after a tick", async () => {
    const fx = setupLoopGoal();
    await runTick(fx);
    expect(existsSync(tickLockFile(fx.location, GOAL))).toBe(false);
  });
});

describe("default-config safety", () => {
  it("a project with no [reconciler] section and no credentials stops with auth_missing and never spawns a model", async () => {
    const fx = setupLoopGoal({ stub: false });
    const result = await runTick(fx);
    expect(result).toMatchObject({ status: "continue", outcome: "stopped", reconciled: false });
    expect(result.signatures.some((s) => s.startsWith("reconcile|failed|auth_missing"))).toBe(true);
    const failed = fx.ledger.readVerified().filter((e) => e.type === "reconcile.failed");
    expect(failed).toHaveLength(1);
    // auth_missing means no process was started; a spawned `claude` shim would have reported nonzero_exit (exit 97).
    expect(failed[0]?.payload.code).toBe("auth_missing");
  });
});
