import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMarkdownStore } from "../../src/adapters/state-markdown.js";
import { budgetState } from "../../src/core/budget.js";
import type { LedgerEvent } from "../../src/core/ledger.js";
import { resumeGoal } from "../../src/goal/lifecycle.js";
import { lockFile } from "../../src/goal/metrics.js";
import { runStateFromEvents } from "../../src/goal/run-state.js";
import { isStalled } from "../../src/goal/tick.js";
import { claimItem, releaseItem } from "../../src/work/claim.js";
import {
  GOAL,
  type LoopFixture,
  runTick,
  setMeasured,
  setPlan,
  setupLoopGoal,
  stubCalls,
} from "../helpers/tick-loop.js";

const mark = (fx: LoopFixture): number => fx.ledger.readVerified().length;
const since = (fx: LoopFixture, at: number): LedgerEvent[] => fx.ledger.readVerified().slice(at);
const count = (events: readonly LedgerEvent[], type: string): number => events.filter((e) => e.type === type).length;
const consumed = (fx: LoopFixture): number | undefined => budgetState(fx.ledger, GOAL, "rounds")?.consumed;

describe("stall guard (no_progress)", () => {
  it("is a stall only with an earlier answer, an unchanged state and no live claim", () => {
    expect(isStalled({ progress: "a", previous: "a", liveClaim: false })).toBe(true);
    expect(isStalled({ progress: "a", previous: "a", liveClaim: true })).toBe(false);
    expect(isStalled({ progress: "a", previous: "b", liveClaim: false })).toBe(false);
    expect(isStalled({ progress: "a", previous: null, liveClaim: false })).toBe(false);
  });

  it("escalates J6 instead of asking the model again about an unchanged state, and consumes no round", async () => {
    const fx = setupLoopGoal();
    setPlan(fx, { mode: "empty" });
    const first = await runTick(fx);
    expect(first).toMatchObject({ status: "continue", outcome: "no_candidates", reconciled: true });
    const at = mark(fx);

    const second = await runTick(fx);
    expect(second).toMatchObject({
      status: "blocked_on_user",
      outcome: "escalated",
      reason_code: "no_progress",
      reconciled: false,
    });
    expect(second.escalation).toMatchObject({ j: "J6", reason_code: "no_progress" });
    expect(stubCalls(fx)).toBe(1);
    expect(consumed(fx)).toBe(1);

    const events = since(fx, at);
    const types = events.map((e) => e.type);
    expect(count(events, "budget.consumed")).toBe(0);
    expect(count(events, "reconcile.requested")).toBe(0);
    expect(types.indexOf("goal.escalated")).toBeGreaterThan(-1);
    expect(types.indexOf("goal.terminated")).toBe(types.indexOf("goal.escalated") + 1);
    expect(types.at(-1)).toBe("goal.tick_ended");
    expect(events.at(-1)?.payload).toMatchObject({ outcome: "escalated", model_calls: 0, reconciled: false });
    expect(runStateFromEvents(fx.ledger.readVerified(), GOAL).status).toBe("blocked_on_user");
  });

  it("asks the model again after a person resumed", async () => {
    const fx = setupLoopGoal();
    setPlan(fx, { mode: "empty" });
    await runTick(fx);
    await runTick(fx);
    expect(stubCalls(fx)).toBe(1);
    resumeGoal(fx.ledger, GOAL, "human:dev");
    const third = await runTick(fx);
    expect(third).toMatchObject({ status: "continue", outcome: "no_candidates", reconciled: true });
    expect(stubCalls(fx)).toBe(2);
  });

  it("waits at the work-in-progress cap: no model call, no round, no escalation, however many ticks", async () => {
    const fx = setupLoopGoal();
    setPlan(fx, { mode: "ok", count: 2 });
    const first = await runTick(fx);
    expect(first).toMatchObject({ status: "continue", outcome: "dispatched" });
    expect(first.created).toHaveLength(2);
    const at = mark(fx);
    for (let n = 0; n < 4; n += 1) {
      expect(await runTick(fx)).toMatchObject({ status: "continue", outcome: "wip_full", escalation: null });
    }
    expect(stubCalls(fx)).toBe(1);
    expect(consumed(fx)).toBe(1);
    const events = since(fx, at);
    expect(count(events, "goal.escalated")).toBe(0);
    expect(count(events, "budget.consumed")).toBe(0);
  });

  it("does not call an unchanged state a stall while a work run holds a claim", async () => {
    const fx = setupLoopGoal();
    setPlan(fx, { mode: "ok", count: 1 });
    await runTick(fx);
    setPlan(fx, { mode: "empty" });
    const second = await runTick(fx);
    expect(second).toMatchObject({ outcome: "no_candidates", reconciled: true });

    const [item] = createMarkdownStore(fx.location.dir).fetchAllWorkItems(GOAL);
    if (item === undefined) throw new Error("expected the dispatched item");
    claimItem(item.dir);
    try {
      const third = await runTick(fx);
      expect(third).toMatchObject({ status: "continue", outcome: "no_candidates", escalation: null });
      expect(stubCalls(fx)).toBe(3);
    } finally {
      releaseItem(item.dir);
    }

    const fourth = await runTick(fx);
    expect(fourth).toMatchObject({ status: "blocked_on_user", reason_code: "no_progress" });
    expect(stubCalls(fx)).toBe(3);
  });
});

describe("signature breaker (repeated_signature)", () => {
  it("trips J6 on the third identical model failure", async () => {
    const fx = setupLoopGoal();
    setPlan(fx, { mode: "fail" });
    const first = await runTick(fx);
    const second = await runTick(fx);
    expect(first).toMatchObject({ status: "continue", reconciled: false });
    expect(second).toMatchObject({ status: "continue", reconciled: false });

    const third = await runTick(fx);
    expect(third).toMatchObject({ status: "blocked_on_user", outcome: "escalated", reason_code: "repeated_signature" });
    expect(third.escalation).toMatchObject({ j: "J6", reason_code: "repeated_signature" });
    const signature = third.escalation?.signature ?? "";
    expect(signature).toMatch(/^reconcile\|failed\|/);
    expect(first.signatures).toContain(signature);
    expect(second.signatures).toContain(signature);
    expect(third.signatures).toContain(signature);

    // The model was called, and a round spent, on all three ticks: a failed call is retryable until the breaker trips.
    expect(stubCalls(fx)).toBe(3);
    expect(consumed(fx)).toBe(3);
    expect(count(fx.ledger.readVerified(), "reconcile.failed")).toBe(3);
    const state = runStateFromEvents(fx.ledger.readVerified(), GOAL);
    expect(state.status).toBe("blocked_on_user");
    expect(state.open_escalation?.signature).toBe(signature);
  });

  it("trips on three empty answers only when the state keeps changing; an unchanged state stalls at tick 2", async () => {
    const fx = setupLoopGoal();
    setPlan(fx, { mode: "empty" });
    const first = await runTick(fx);
    expect(first).toMatchObject({ status: "continue", outcome: "no_candidates" });
    // A noisy metric changes the progress signature, so the stall guard stays quiet (documented limit).
    setMeasured(fx, "4818.39");
    const second = await runTick(fx);
    expect(second).toMatchObject({ status: "continue", outcome: "no_candidates", escalation: null });
    setMeasured(fx, "4819.39");
    const third = await runTick(fx);
    expect(third).toMatchObject({ status: "blocked_on_user", outcome: "escalated", reason_code: "repeated_signature" });
    expect(third.escalation?.signature).toMatch(/^reconcile\|empty\|/);
    expect(stubCalls(fx)).toBe(3);
    expect(consumed(fx)).toBe(3);

    // The same three empty answers with an unchanged metric never reach the breaker: tick 2 is already a stall.
    const still = setupLoopGoal();
    setPlan(still, { mode: "empty" });
    await runTick(still);
    expect(await runTick(still)).toMatchObject({ reason_code: "no_progress" });
  });

  it("trips on the third audit stop, and the next steps name the repair (audit, then approve)", async () => {
    const fx = setupLoopGoal();
    const file = lockFile(fx.location.dir, GOAL, "m-p95");
    const lock = JSON.parse(readFileSync(file, "utf8")) as { command: string[] };
    lock.command = ["sh", "-c", "echo 1"];
    writeFileSync(file, JSON.stringify(lock));

    const first = await runTick(fx);
    const second = await runTick(fx);
    expect(first).toMatchObject({ status: "continue", outcome: "stopped" });
    expect(second).toMatchObject({ status: "continue", outcome: "stopped" });

    const third = await runTick(fx);
    expect(third).toMatchObject({ status: "blocked_on_user", outcome: "escalated", reason_code: "repeated_signature" });
    expect(third.escalation?.signature).toMatch(/^audit\|stopped\|/);
    const steps = third.next_steps;
    const audit = steps.indexOf(`omf goal audit ${GOAL}`);
    const approve = steps.indexOf(`omf goal approve ${GOAL}`);
    expect(audit).toBeGreaterThan(-1);
    expect(approve).toBeGreaterThan(audit);

    expect(count(fx.ledger.readVerified(), "goal.audit_failed")).toBe(3);
    expect(stubCalls(fx)).toBe(0);
    expect(consumed(fx)).toBe(0);
  });
});
