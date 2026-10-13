import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMarkdownStore, type NewWorkItem } from "../../src/adapters/state-markdown.js";
import {
  ESCALATIONS,
  cancelGoal,
  escalate,
  nextSteps,
  resumeGoal,
  stoppedNextSteps,
  terminate,
} from "../../src/goal/lifecycle.js";
import { type Escalation, runStateFromEvents } from "../../src/goal/run-state.js";
import { TICK_RUNNING_MESSAGE, TickRunningError, tickLockFile, withTickLock } from "../../src/goal/tick-lock.js";
import { claimItem, releaseItem } from "../../src/work/claim.js";
import { fingerprintOf } from "../../src/work/fingerprint.js";
import type { IntentCandidate, WorkItem, WorkState } from "../../src/work/types.js";
import { parseWorkItem, renderWorkItem } from "../../src/work/work-item.js";
import { setupGoal } from "../helpers/goal.js";

const G = "g-fast";
const TICK = "t-20261012T000000Z-0a1b";
const NOW = new Date("2026-10-12T00:00:00.000Z");

function newItem(title: string, risk: "normal" | "high"): NewWorkItem {
  const candidate: IntentCandidate = {
    title,
    problem: "a problem",
    proposed_outcome: "an outcome",
    affected_users_systems: "the service",
    constraints: "",
    open_questions: [],
    rationale: "why",
    affected_paths: ["src/a.ts"],
  };
  return {
    goal_id: G,
    tick_id: TICK,
    trigger: "gap",
    candidate,
    fingerprint: fingerprintOf(G, candidate),
    risk: { class: risk, rules: risk === "high" ? ["ci"] : [], paths: ["src/a.ts"] },
  };
}

function createItem(projectDir: string, title: string, risk: "normal" | "high" = "normal"): WorkItem {
  const result = createMarkdownStore(projectDir).createWorkItem(newItem(title, risk), NOW);
  if (!result.created) throw new Error("fixture item already exists");
  return result.item;
}

/** Puts an item into a state the M2b verbs cannot reach (W states arrive in M3) by rewriting its item.md. */
function setItemState(item: WorkItem, state: WorkState): void {
  const file = join(item.dir, "item.md");
  const { front, progress } = parseWorkItem(readFileSync(file, "utf8"));
  writeFileSync(file, renderWorkItem({ ...front, state }, progress));
}

describe("ESCALATIONS", () => {
  const J: Record<string, string> = {
    goal_not_approved: "J1",
    reapproval_required: "J1",
    stale_goal: "J1",
    approach_unusable: "J1",
    wall_time_exceeded: "J8",
    rounds_exhausted: "J8",
    disclosure_exhausted: "J8",
    no_progress: "J6",
    repeated_signature: "J6",
  };

  it("catalogues exactly the nine reason codes with their judgment point", () => {
    expect(Object.keys(ESCALATIONS).sort()).toEqual(Object.keys(J).sort());
    for (const [code, j] of Object.entries(J)) expect(ESCALATIONS[code]?.j, code).toBe(j);
  });

  it("gives every code a question, options and the default `stay stopped` (J6: stay stopped unless a person decides)", () => {
    for (const [code, entry] of Object.entries(ESCALATIONS)) {
      expect(entry.question.length, code).toBeGreaterThan(0);
      expect(entry.options.length, code).toBeGreaterThan(0);
      for (const option of entry.options) expect(option.length, code).toBeGreaterThan(0);
      expect(entry.default, code).toBe("stay stopped");
    }
  });
});

describe("escalate and terminate", () => {
  it("appends goal.escalated then goal.terminated(blocked_on_user) with the catalogued J code", () => {
    const fx = setupGoal();
    const before = fx.ledger.readVerified().length;
    const escalation = escalate(fx.ledger, G, TICK, "wall_time_exceeded", null);
    const added = fx.ledger.readVerified().slice(before);
    expect(added.map((event) => event.type)).toEqual(["goal.escalated", "goal.terminated"]);
    expect(added[0]?.actor).toBe("omf");
    expect(added[0]?.payload).toMatchObject({
      goal_id: G,
      tick_id: TICK,
      j: "J8",
      reason_code: "wall_time_exceeded",
      signature: null,
      default: "stay stopped",
    });
    expect(added[1]?.payload).toMatchObject({ goal_id: G, tick_id: TICK, state: "blocked_on_user", reason_code: "wall_time_exceeded" });
    expect(escalation).toMatchObject({ tick_id: TICK, j: "J8", reason_code: "wall_time_exceeded", signature: null });
    expect(runStateFromEvents(fx.ledger.readVerified(), G)).toMatchObject({
      status: "blocked_on_user",
      open_escalation: { j: "J8", reason_code: "wall_time_exceeded" },
    });
  });

  it("records the repeating signature, and refuses an unknown reason code without writing", () => {
    const fx = setupGoal();
    const escalation = escalate(fx.ledger, G, TICK, "repeated_signature", "audit|stopped|goal lock tampered");
    expect(escalation.signature).toBe("audit|stopped|goal lock tampered");
    const count = fx.ledger.readVerified().length;
    expect(() => escalate(fx.ledger, G, TICK, "made_up", null)).toThrow(/unknown escalation reason code made_up/);
    expect(fx.ledger.readVerified()).toHaveLength(count);
  });

  it("terminate writes goal.terminated as omf by default and as a person when told", () => {
    const fx = setupGoal();
    const failed = terminate(fx.ledger, G, "failed", TICK, "internal_error");
    expect(failed).toMatchObject({ actor: "omf", type: "goal.terminated", payload: { goal_id: G, tick_id: TICK, state: "failed", reason_code: "internal_error" } });
    const cancelled = terminate(fx.ledger, G, "cancelled", null, "cancelled_by_user", "human:dev");
    expect(cancelled.actor).toBe("human:dev");
    expect(cancelled.payload.tick_id).toBeNull();
  });
});

describe("resumeGoal", () => {
  it("is for people only", () => {
    const fx = setupGoal();
    escalate(fx.ledger, G, TICK, "no_progress", null);
    const count = fx.ledger.readVerified().length;
    expect(() => resumeGoal(fx.ledger, G, "omf")).toThrow(/only a person may resume a goal/);
    expect(fx.ledger.readVerified()).toHaveLength(count);
  });

  it("resumes a blocked goal and a failed goal, recording where it came from", () => {
    const fx = setupGoal();
    escalate(fx.ledger, G, TICK, "no_progress", null);
    expect(resumeGoal(fx.ledger, G, "human:dev")).toMatchObject({ status: "running", open_escalation: null });
    expect(fx.ledger.readVerified().at(-1)).toMatchObject({ actor: "human:dev", type: "goal.resumed", payload: { goal_id: G, from: "blocked_on_user" } });

    terminate(fx.ledger, G, "failed", TICK, "internal_error");
    expect(resumeGoal(fx.ledger, G, "human:dev").status).toBe("running");
    expect(fx.ledger.readVerified().at(-1)?.payload).toMatchObject({ from: "failed" });
  });

  it("refuses a running goal and a finished goal, and writes nothing", () => {
    const fx = setupGoal();
    const count = fx.ledger.readVerified().length;
    expect(() => resumeGoal(fx.ledger, G, "human:dev")).toThrow(/goal g-fast is running; only a blocked_on_user or failed goal can be resumed/);
    terminate(fx.ledger, G, "finish", TICK, "success_candidate");
    expect(() => resumeGoal(fx.ledger, G, "human:dev")).toThrow(/is finish/);
    expect(fx.ledger.readVerified()).toHaveLength(count + 1);
  });
});

describe("cancelGoal", () => {
  it("cancels every open item, also a claimed one and one that is in progress, and leaves done items alone", () => {
    const fx = setupGoal();
    const store = createMarkdownStore(fx.location.dir);
    const ready = createItem(fx.location.dir, "Add retries");
    const awaiting = createItem(fx.location.dir, "Touch the workflow", "high");
    const running = createItem(fx.location.dir, "Cache lookups");
    const done = createItem(fx.location.dir, "Old work");
    setItemState(running, "in_progress");
    setItemState(done, "done");
    const before = fx.ledger.readVerified().length;

    claimItem(running.dir);
    let result: { cancelled: string[] };
    try {
      result = cancelGoal(fx.ledger, store, G, "human:dev", NOW);
    } finally {
      releaseItem(running.dir);
    }

    const ids = [ready, awaiting, running].map((item) => item.front.work_id).sort();
    expect([...result.cancelled].sort()).toEqual(ids);
    const states = Object.fromEntries(store.fetchAllWorkItems(G).map((item) => [item.front.work_id, item.front.state]));
    expect(states).toEqual({
      [ready.front.work_id]: "cancelled",
      [awaiting.front.work_id]: "cancelled",
      [running.front.work_id]: "cancelled",
      [done.front.work_id]: "done",
    });

    const added = fx.ledger.readVerified().slice(before);
    expect(added.map((event) => event.type)).toEqual(["work.cancelled", "work.cancelled", "work.cancelled", "goal.terminated"]);
    for (const event of added.slice(0, 3)) {
      expect(event.actor).toBe("human:dev");
      expect(event.payload).toMatchObject({ goal_id: G, cause: "goal_cancelled" });
    }
    expect(added[3]).toMatchObject({ actor: "human:dev", payload: { goal_id: G, tick_id: null, state: "cancelled", reason_code: "cancelled_by_user" } });
    expect(runStateFromEvents(fx.ledger.readVerified(), G).status).toBe("cancelled");
  });

  it("is for people only", () => {
    const fx = setupGoal();
    const count = fx.ledger.readVerified().length;
    expect(() => cancelGoal(fx.ledger, createMarkdownStore(fx.location.dir), G, "omf", NOW)).toThrow(/only a person may cancel a goal/);
    expect(fx.ledger.readVerified()).toHaveLength(count);
  });

  it("works from blocked_on_user and failed, but is refused from finish and cancelled", () => {
    const fx = setupGoal();
    const store = createMarkdownStore(fx.location.dir);
    terminate(fx.ledger, G, "failed", TICK, "internal_error");
    expect(cancelGoal(fx.ledger, store, G, "human:dev", NOW)).toEqual({ cancelled: [] });
    expect(runStateFromEvents(fx.ledger.readVerified(), G).status).toBe("cancelled");
    const count = fx.ledger.readVerified().length;
    expect(() => cancelGoal(fx.ledger, store, G, "human:dev", NOW)).toThrow(/goal g-fast is already cancelled; nothing to cancel/);
    expect(fx.ledger.readVerified()).toHaveLength(count);

    const other = setupGoal();
    terminate(other.ledger, G, "finish", TICK, "success_candidate");
    expect(() => cancelGoal(other.ledger, createMarkdownStore(other.location.dir), G, "human:dev", NOW)).toThrow(/already finish/);
  });
});

describe("nextSteps", () => {
  const D = "g-demo";
  const escalationFor = (code: string, signature: string | null = null): Escalation => {
    const entry = ESCALATIONS[code];
    if (entry === undefined) throw new Error(`no such code ${code}`);
    return { tick_id: TICK, j: entry.j, reason_code: code, signature, question: entry.question, options: entry.options, default: entry.default, at: NOW.toISOString() };
  };

  const rows: [string, string | null, string[]][] = [
    ["goal_not_approved", null, ["omf goal approve g-demo"]],
    ["reapproval_required", null, ["omf goal audit g-demo", "omf goal approve g-demo"]],
    ["stale_goal", null, ["omf goal approve g-demo"]],
    [
      "approach_unusable",
      null,
      ["edit goal.md: remove metric names and numbers from the objective and the ## Approach section", "omf goal resume g-demo"],
    ],
    ["wall_time_exceeded", null, ["omf budget raise g-demo wall_time <dur>", "omf goal resume g-demo"]],
    ["rounds_exhausted", null, ["omf budget raise g-demo rounds <n>", "omf goal resume g-demo"]],
    ["disclosure_exhausted", null, ["omf budget raise g-demo disclosure <n>", "omf goal resume g-demo"]],
    [
      "no_progress",
      null,
      ["omf work list g-demo", "omf work approve <work_id>", "omf veto <work_id>", "omf goal resume g-demo", "omf goal cancel g-demo"],
    ],
    [
      "repeated_signature",
      "audit|stopped|goal lock tampered",
      ["omf goal audit g-demo", "omf goal approve g-demo", "omf goal resume g-demo"],
    ],
    [
      "repeated_signature",
      "measure|failed|metric command failed",
      ["read the latest tick reports to see why the same outcome repeated", "omf goal resume g-demo", "omf goal cancel g-demo"],
    ],
    [
      "repeated_signature",
      null,
      ["read the latest tick reports to see why the same outcome repeated", "omf goal resume g-demo", "omf goal cancel g-demo"],
    ],
  ];

  it.each(rows)("%s (signature %s) names exactly these steps", (code, signature, expected) => {
    expect(nextSteps(escalationFor(code, signature), D)).toEqual(expected);
  });

  it("covers every code in the catalogue", () => {
    expect(new Set(rows.map(([code]) => code))).toEqual(new Set(Object.keys(ESCALATIONS)));
  });

  it("refuses a reason code it has no steps for", () => {
    expect(() => nextSteps({ ...escalationFor("no_progress"), reason_code: "made_up" }, D)).toThrow(/no next steps for made_up/);
  });

  it("stoppedNextSteps uses the open escalation, and falls back for a failed or hand-blocked goal", () => {
    const base = { since: null, reason_code: null, ticks: 0 } as const;
    expect(stoppedNextSteps({ ...base, status: "blocked_on_user", open_escalation: escalationFor("stale_goal") }, D)).toEqual(["omf goal approve g-demo"]);
    expect(stoppedNextSteps({ ...base, status: "failed", open_escalation: null }, D)).toEqual([
      "read the latest tick report for the error",
      "omf goal resume g-demo",
      "omf goal cancel g-demo",
    ]);
    expect(stoppedNextSteps({ ...base, status: "blocked_on_user", open_escalation: null }, D)).toEqual(["omf goal audit g-demo", "omf goal resume g-demo"]);
    expect(stoppedNextSteps({ ...base, status: "running", open_escalation: null }, D)).toEqual([]);
    expect(stoppedNextSteps({ ...base, status: "finish", open_escalation: null }, D)).toEqual([]);
  });
});

describe("withTickLock", () => {
  it("runs the callback, returns its value and removes the lock file", async () => {
    const fx = setupGoal();
    const file = tickLockFile(fx.location, G);
    const value = await withTickLock(fx.location, G, async () => {
      expect(existsSync(file)).toBe(true);
      return 42;
    });
    expect(value).toBe(42);
    expect(existsSync(file)).toBe(false);
  });

  it("refuses a second holder with `a tick is running; retry`", async () => {
    const fx = setupGoal();
    await withTickLock(fx.location, G, async () => {
      const second = withTickLock(fx.location, G, () => "never");
      await expect(second).rejects.toThrow(TickRunningError);
      await expect(withTickLock(fx.location, G, () => "never")).rejects.toThrow(TICK_RUNNING_MESSAGE);
    });
    expect(TICK_RUNNING_MESSAGE).toBe("a tick is running; retry");
  });

  it("releases the lock when the callback throws", async () => {
    const fx = setupGoal();
    await expect(withTickLock(fx.location, G, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(existsSync(tickLockFile(fx.location, G))).toBe(false);
    expect(await withTickLock(fx.location, G, () => "again")).toBe("again");
  });

  it("reclaims a lock whose process has exited", async () => {
    const fx = setupGoal();
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(tickLockFile(fx.location, G), JSON.stringify({ pid: dead, start_time: "x", acquired_at: "x" }));
    expect(await withTickLock(fx.location, G, () => "ran")).toBe("ran");
  });

  it("refuses an unknown or malformed goal id without creating a lock", async () => {
    const fx = setupGoal();
    await expect(withTickLock(fx.location, "g-nope", () => "x")).rejects.toThrow(/goal g-nope not found; run omf goal new g-nope/);
    expect(existsSync(tickLockFile(fx.location, "g-nope"))).toBe(false);
    await expect(withTickLock(fx.location, "NOT AN ID", () => "x")).rejects.toThrow();
  });
});
