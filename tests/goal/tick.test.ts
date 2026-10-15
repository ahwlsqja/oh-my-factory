import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { workItemDir } from "../../src/adapters/state-markdown.js";
import { budgetState } from "../../src/core/budget.js";
import { approveGoal } from "../../src/goal/approve.js";
import { MIN_BASELINE_POINTS } from "../../src/goal/bands.js";
import { goalLockFile } from "../../src/goal/goal-lock.js";
import { resumeGoal } from "../../src/goal/lifecycle.js";
import type { TickResult } from "../../src/goal/tick.js";
import { raiseWallTime } from "../../src/goal/wall-time.js";
import {
  MIN_OBSERVATION_MS,
  TICK_GOAL,
  type TickFixture,
  candidateOf,
  lastTickEvents,
  lastTickTypes,
  ledgerEvents,
  seedRepairable,
  seedWorkItem,
  setP95,
  setupTick,
} from "../helpers/tick.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function count(fx: TickFixture, type: string): number {
  return ledgerEvents(fx).filter((event) => event.type === type).length;
}

function workIdAt(result: TickResult, index: number): string {
  const created = result.created[index];
  if (created === undefined) throw new Error(`the tick created no work item at index ${index}`);
  return created.work_id;
}

function reportText(fx: TickFixture, result: TickResult): string {
  if (result.report === null) throw new Error("the tick wrote no report");
  return readFileSync(join(fx.location.dir, result.report), "utf8");
}

const GATE_STOP = ["goal.tick_started", "goal.escalated", "goal.terminated", "goal.tick_ended"];

describe("tickGoal: turn 1", () => {
  it("measures, reconciles once, dispatches ready items, and consumes one round right before the model call", async () => {
    const fx = setupTick();
    fx.reconciler.reply([candidateOf("Cache the render path"), candidateOf("Trim the render output", ["src/output"])]);

    const result = await fx.tick();

    expect(result).toMatchObject({
      goal_id: TICK_GOAL,
      status: "continue",
      outcome: "dispatched",
      reconciled: true,
      escalation: null,
      awaiting_approval: [],
    });
    expect(result.created.map((item) => [item.state, item.risk])).toEqual([
      ["ready", "normal"],
      ["ready", "normal"],
    ]);
    expect(fx.reconciler.calls).toBe(1);
    expect(lastTickTypes(fx)).toEqual([
      "goal.tick_started",
      "metric.measured",
      "goal.measured",
      "budget.consumed",
      "reconcile.requested",
      "reconcile.responded",
      "work.created",
      "work.created",
      "goal.tick_ended",
    ]);
    const events = lastTickEvents(fx);
    expect(events[3]?.payload).toEqual({ goal_id: TICK_GOAL, kind: "rounds", amount: 1 });
    expect(events.at(-1)?.payload).toMatchObject({
      status: "continue",
      outcome: "dispatched",
      model_calls: 1,
      reconciled: true,
      created: 2,
      rounds_remaining: 9,
      report: result.report,
    });
    const text = reportText(fx, result);
    for (const created of result.created) expect(text).toContain(`omf veto ${created.work_id}`);
  });

  it("records a failed model call as a stopped tick that still used its round", async () => {
    const fx = setupTick();
    fx.reconciler.fail("nonzero_exit");

    const result = await fx.tick();

    expect(result).toMatchObject({
      status: "continue",
      outcome: "stopped",
      reason_code: "nonzero_exit",
      reconciled: false,
    });
    expect(result.signatures).toHaveLength(1);
    expect(result.signatures[0]).toMatch(/^reconcile\|failed\|/);
    expect(lastTickTypes(fx)).toEqual([
      "goal.tick_started",
      "metric.measured",
      "goal.measured",
      "budget.consumed",
      "reconcile.requested",
      "reconcile.failed",
      "goal.tick_ended",
    ]);
    expect(lastTickEvents(fx).at(-1)?.payload).toMatchObject({
      model_calls: 1,
      reconciled: false,
      rounds_remaining: 9,
    });
  });
});

describe("tickGoal: turn 2 (the walking skeleton)", () => {
  it("finishes on two met measurements spanning min_observation, with no model call and no round", async () => {
    const fx = setupTick();
    fx.reconciler.reply([candidateOf("Cache the render path")]);
    expect((await fx.tick()).outcome).toBe("dispatched");
    expect(count(fx, "budget.consumed")).toBe(1);

    // The value file is what changes; the watched script is untouched, so J1 is not involved.
    setP95(fx, 200);
    fx.clock.advance(MINUTE);
    const first = await fx.tick();
    expect(first).toMatchObject({ status: "continue", outcome: "observing" });

    fx.clock.advance(MIN_OBSERVATION_MS + MINUTE);
    const second = await fx.tick();
    expect(second).toMatchObject({ status: "finish", outcome: "success_candidate" });
    expect(lastTickTypes(fx)).toEqual([
      "goal.tick_started",
      "metric.measured",
      "goal.measured",
      "goal.success_candidate",
      "goal.terminated",
      "goal.tick_ended",
    ]);
    expect(lastTickEvents(fx).find((e) => e.type === "goal.success_candidate")?.payload).toMatchObject({
      goal_id: TICK_GOAL,
      regime: 1,
      consecutive: 2,
      min_observation_ms: MIN_OBSERVATION_MS,
      attribution: "before_after",
      correlational: true,
    });

    expect(fx.reconciler.calls).toBe(1);
    expect(count(fx, "budget.consumed")).toBe(1);

    const before = ledgerEvents(fx).length;
    const third = await fx.tick();
    expect(third).toMatchObject({ status: "finish", outcome: "already_final" });
    expect(ledgerEvents(fx)).toHaveLength(before);
  });

  it("succeeds with a guardrail only once its bands have a baseline and say pass", async () => {
    const fx = setupTick({ p95: 200, guardrail: "bands" });
    for (let i = 0; i < MIN_BASELINE_POINTS; i++) {
      fx.clock.advance(MINUTE);
      expect((await fx.tick()).outcome).toBe("observing");
    }
    fx.clock.advance(MINUTE);
    expect((await fx.tick()).outcome).toBe("observing");

    fx.clock.advance(MIN_OBSERVATION_MS + MINUTE);
    expect(await fx.tick()).toMatchObject({ status: "finish", outcome: "success_candidate" });

    const guardrails = ledgerEvents(fx)
      .filter((event) => event.type === "goal.measured")
      .map((event) => event.payload.guardrails);
    expect(guardrails).toEqual([...Array<string>(MIN_BASELINE_POINTS).fill("unevaluated"), "pass", "pass"]);
    expect(fx.reconciler.calls).toBe(0);
  });

  it("never succeeds while a guardrail has no bands file, however long it is observed", async () => {
    const fx = setupTick({ p95: 200, guardrail: "no-bands" });
    for (let i = 0; i < MIN_BASELINE_POINTS + 4; i++) {
      fx.clock.advance(MIN_OBSERVATION_MS + MINUTE);
      expect(await fx.tick()).toMatchObject({ status: "continue", outcome: "observing" });
    }
    expect(count(fx, "goal.success_candidate")).toBe(0);
    const guardrails = new Set(
      ledgerEvents(fx)
        .filter((event) => event.type === "goal.measured")
        .map((event) => event.payload.guardrails),
    );
    expect([...guardrails]).toEqual(["unevaluated"]);
  });

  it("restarts the success streak when the goal is re-approved (D9c)", async () => {
    const fx = setupTick({ p95: 200 });
    expect((await fx.tick()).outcome).toBe("observing");

    // Without a re-approval the next tick would finish: min_observation has passed since the first met measurement.
    fx.clock.advance(MIN_OBSERVATION_MS + MINUTE);
    writeFileSync(
      fx.goalFile,
      readFileSync(fx.goalFile, "utf8").replace(
        "Why moving the leading metrics should move the lagging ones",
        "Because the render path dominates the page time",
      ),
    );
    expect(approveGoal(fx.location, TICK_GOAL, "human:dev", fx.clock.now)).toMatchObject({
      created: true,
      approval: { regime: 2 },
    });

    const afterApproval = await fx.tick();
    expect(afterApproval).toMatchObject({ status: "continue", outcome: "observing" });
    expect(lastTickEvents(fx).find((e) => e.type === "goal.measured")?.payload).toMatchObject({ regime: 2 });

    fx.clock.advance(MIN_OBSERVATION_MS + MINUTE);
    expect(await fx.tick()).toMatchObject({ status: "finish", outcome: "success_candidate" });
  });
});

describe("tickGoal: ticks with no trigger", () => {
  it("observes a met target without calling the model, creating items or consuming a round", async () => {
    const fx = setupTick({ p95: 200 });

    const result = await fx.tick();

    expect(result).toMatchObject({ status: "continue", outcome: "observing", reconciled: false, created: [] });
    expect(fx.reconciler.calls).toBe(0);
    expect(count(fx, "work.created")).toBe(0);
    expect(count(fx, "budget.consumed")).toBe(0);
    expect(lastTickEvents(fx).at(-1)?.payload).toMatchObject({ model_calls: 0, rounds_remaining: 10 });
  });

  it("is idle in watch mode without a breach, and idle ticks never spend the rounds budget", async () => {
    const fx = setupTick({ mode: "watch", rounds: 3 });
    for (let i = 0; i < 8; i++) {
      fx.clock.advance(MINUTE);
      expect(await fx.tick()).toMatchObject({ status: "continue", outcome: "idle" });
    }
    expect(fx.reconciler.calls).toBe(0);
    expect(count(fx, "budget.consumed")).toBe(0);
    expect(budgetState(fx.ledger, TICK_GOAL, "rounds")?.remaining).toBe(3);
  });

  it("reconciles with trigger breach when a watched metric breaches a band whose action is propose", async () => {
    const fx = setupTick({ mode: "watch", rounds: 3, targetBands: true });
    fx.reconciler.reply([candidateOf("Cache the render path")]);
    for (let i = 0; i <= MIN_BASELINE_POINTS; i++) {
      fx.clock.advance(MINUTE);
      expect((await fx.tick()).outcome).toBe("idle");
    }

    setP95(fx, 600);
    fx.clock.advance(MINUTE);
    const result = await fx.tick();

    expect(result).toMatchObject({ status: "continue", outcome: "dispatched" });
    expect(fx.reconciler.calls).toBe(1);
    expect(lastTickEvents(fx).find((e) => e.type === "reconcile.requested")?.payload).toMatchObject({
      trigger: "breach",
      disclosed: { gap: null, breach: { severity: "severe" } },
    });
  });
});

describe("tickGoal: gates", () => {
  it("escalates J1 goal_not_approved for a draft goal", async () => {
    const fx = setupTick({ approve: false });

    const result = await fx.tick();

    expect(result).toMatchObject({ status: "blocked_on_user", outcome: "escalated", reason_code: "goal_not_approved" });
    expect(result.escalation?.j).toBe("J1");
    expect(result.next_steps).toContain(`omf goal approve ${TICK_GOAL}`);
    expect(lastTickTypes(fx)).toEqual(GATE_STOP);
    expect(count(fx, "budget.consumed")).toBe(0);
  });

  it("stops on a tampered goal lock, recording goal.audit_failed and measuring nothing", async () => {
    const fx = setupTick();
    const file = goalLockFile(fx.location.dir, TICK_GOAL);
    const lock = JSON.parse(readFileSync(file, "utf8")) as { semantic: { target: { value: number } } };
    lock.semantic.target.value = 9999;
    writeFileSync(file, JSON.stringify(lock, null, 2));

    const result = await fx.tick();

    expect(result).toMatchObject({ status: "continue", outcome: "stopped", reconciled: false });
    expect(result.signatures).toHaveLength(1);
    expect(result.signatures[0]).toMatch(/^audit\|stopped\|/);
    expect(lastTickTypes(fx)).toEqual(["goal.tick_started", "goal.audit_failed", "goal.tick_ended"]);
    expect(fx.reconciler.calls).toBe(0);
  });

  it("escalates J1 reapproval_required and measures nothing when the watched script changed", async () => {
    const fx = setupTick();
    // Control for the walking skeleton: the script is what J1 locked, the value file is not.
    writeFileSync(join(fx.repo, "bench", "p95.sh"), "cat bench/p95.value\n# edited after approval\n");

    const result = await fx.tick();

    expect(result).toMatchObject({
      status: "blocked_on_user",
      outcome: "escalated",
      reason_code: "reapproval_required",
    });
    expect(result.escalation?.j).toBe("J1");
    expect(result.next_steps).toContain(`omf goal approve ${TICK_GOAL}`);
    expect(lastTickTypes(fx)).toEqual(GATE_STOP);
    expect(fx.reconciler.calls).toBe(0);
  });

  it("escalates J8 wall_time_exceeded, then runs again after a raise and a resume", async () => {
    const fx = setupTick();
    fx.reconciler.reply([candidateOf("Cache the render path")]);
    fx.clock.advance(100 * HOUR);

    const blocked = await fx.tick();
    expect(blocked).toMatchObject({
      status: "blocked_on_user",
      outcome: "escalated",
      reason_code: "wall_time_exceeded",
    });
    expect(blocked.escalation?.j).toBe("J8");
    expect(lastTickTypes(fx)).toEqual(GATE_STOP);
    expect(count(fx, "budget.consumed")).toBe(0);

    const before = ledgerEvents(fx).length;
    const stopped = await fx.tick();
    expect(stopped).toMatchObject({
      status: "blocked_on_user",
      outcome: "stopped_until_resumed",
      reason_code: "wall_time_exceeded",
    });
    expect(stopped.next_steps.length).toBeGreaterThan(0);
    expect(ledgerEvents(fx)).toHaveLength(before);

    raiseWallTime(fx.ledger, TICK_GOAL, "48h", "human:dev");
    resumeGoal(fx.ledger, TICK_GOAL, "human:dev");
    expect(await fx.tick()).toMatchObject({ status: "continue", outcome: "dispatched" });
  });

  it("charges only reconciling ticks: waiting ticks leave rounds alone and the next reconcile attempt is J8 rounds_exhausted", async () => {
    const fx = setupTick({ rounds: 1, maxOpen: 5 });
    fx.reconciler.reply([candidateOf("Cache the render path")]);
    expect((await fx.tick()).outcome).toBe("dispatched");
    expect(budgetState(fx.ledger, TICK_GOAL, "rounds")?.remaining).toBe(0);

    setP95(fx, 200);
    fx.clock.advance(MINUTE);
    expect(await fx.tick()).toMatchObject({ status: "continue", outcome: "observing" });
    expect(count(fx, "budget.consumed")).toBe(1);

    setP95(fx, 400);
    fx.clock.advance(MINUTE);
    const result = await fx.tick();

    expect(result).toMatchObject({ status: "blocked_on_user", outcome: "escalated", reason_code: "rounds_exhausted" });
    expect(result.escalation?.j).toBe("J8");
    expect(lastTickTypes(fx)).toEqual([
      "goal.tick_started",
      "metric.measured",
      "goal.measured",
      "goal.escalated",
      "goal.terminated",
      "goal.tick_ended",
    ]);
    expect(fx.reconciler.calls).toBe(1);
    expect(count(fx, "budget.consumed")).toBe(1);
  });
});

describe("tickGoal: stale lifecycle (D21)", () => {
  it("marks the goal stale, escalates J1 stale_goal on the next tick, and runs normally after re-approval", async () => {
    const fx = setupTick();
    fx.reconciler.reply([candidateOf("Cache the render path"), candidateOf("Trim the render output", ["src/output"])]);
    expect((await fx.tick()).outcome).toBe("dispatched");

    // The target got more than twice as bad as the first in-regime measurement: stale, by REFRESH.max_target_move.
    setP95(fx, 700);
    fx.clock.advance(MINUTE);
    const marking = await fx.tick();
    expect(marking).toMatchObject({ status: "continue", outcome: "wip_full" });
    expect(lastTickTypes(fx)).toEqual([
      "goal.tick_started",
      "metric.measured",
      "goal.measured",
      "goal.stale",
      "goal.tick_ended",
    ]);
    expect(lastTickEvents(fx).find((e) => e.type === "goal.stale")?.payload).toMatchObject({
      goal_id: TICK_GOAL,
      regime: 1,
      tripped: ["target_move"],
    });

    fx.clock.advance(MINUTE);
    const escalated = await fx.tick();
    expect(escalated).toMatchObject({ status: "blocked_on_user", outcome: "escalated", reason_code: "stale_goal" });
    expect(escalated.escalation?.j).toBe("J1");
    expect(lastTickTypes(fx)).toEqual(GATE_STOP);

    expect(approveGoal(fx.location, TICK_GOAL, "human:dev", fx.clock.now)).toMatchObject({
      created: true,
      approval: { regime: 2 },
    });

    fx.clock.advance(MINUTE);
    const resumed = await fx.tick();
    expect(resumed).toMatchObject({ status: "continue", escalation: null });
    expect(lastTickEvents(fx)[0]?.payload).toMatchObject({ regime: 2 });
    expect(count(fx, "goal.stale")).toBe(1);
  });
});

describe("tickGoal: WIP cap and STOP_IF back-pressure", () => {
  it("waits with wip_full when the open items reach the locked cap, without a model call or a round", async () => {
    const fx = setupTick({ maxOpen: 1 });
    seedWorkItem(fx, { title: "Seeded work" });

    const result = await fx.tick();

    expect(result).toMatchObject({ status: "continue", outcome: "wip_full", reconciled: false });
    expect(fx.reconciler.calls).toBe(0);
    expect(count(fx, "budget.consumed")).toBe(0);
    expect(lastTickEvents(fx).at(-1)?.payload).toMatchObject({ model_calls: 0, rounds_remaining: 10 });
  });

  it("counts a repairable item toward back_pressure by its ledger target state", async () => {
    // Cap 5 keeps the WIP check out of the way: only STOP_IF can stop this tick.
    const fx = setupTick({ maxOpen: 5 });
    seedWorkItem(fx, { title: "Pending review alpha", state: "awaiting_review" });
    seedWorkItem(fx, { title: "Pending review beta", state: "awaiting_review" });
    seedRepairable(fx, "Pending review gamma", "awaiting_review");

    const result = await fx.tick();

    expect(result).toMatchObject({
      status: "continue",
      outcome: "back_pressure",
      reason_code: "stop_if_unreviewed_evidence",
    });
    expect(fx.reconciler.calls).toBe(0);
    expect(count(fx, "budget.consumed")).toBe(0);
  });

  it("counts a repairable item toward the open cap by its file state", async () => {
    const fx = setupTick({ maxOpen: 2 });
    seedWorkItem(fx, { title: "Seeded work" });
    seedRepairable(fx, "Crashed after start", "in_progress");

    const result = await fx.tick();

    expect(result).toMatchObject({ status: "continue", outcome: "wip_full", reconciled: false });
    expect(fx.reconciler.calls).toBe(0);
    expect(count(fx, "budget.consumed")).toBe(0);
  });

  it("agrees with reconcile on the open count: with a cap of 3, one verified and one repairable item leave one slot", async () => {
    const fx = setupTick({ maxOpen: 3 });
    seedWorkItem(fx, { title: "Seeded work" });
    seedRepairable(fx, "Crashed after start", "in_progress");
    fx.reconciler.reply([candidateOf("Cache the render path"), candidateOf("Trim the render output", ["src/output"])]);

    const result = await fx.tick();

    expect(result.outcome).toBe("dispatched");
    expect(ledgerEvents(fx).find((event) => event.type === "reconcile.requested")?.payload.max_candidates).toBe(1);
    expect(result.created).toHaveLength(1);
    expect(result.rejected.map((r) => [r.filter, r.reason_code])).toEqual([["wip_cap", "cap_reached"]]);
  });

  it("waits with back_pressure when three items await review, before the WIP check", async () => {
    const fx = setupTick();
    for (const title of ["Pending review alpha", "Pending review beta", "Pending review gamma"]) {
      seedWorkItem(fx, { title, state: "awaiting_review" });
    }

    const result = await fx.tick();

    expect(result).toMatchObject({ status: "continue", outcome: "back_pressure", reconciled: false });
    expect(fx.reconciler.calls).toBe(0);
    expect(count(fx, "budget.consumed")).toBe(0);
  });

  it("holds a high-risk candidate for approval, lists it, and counts it toward the cap", async () => {
    const fx = setupTick({ maxOpen: 1 });
    fx.reconciler.reply([candidateOf("Change the release pipeline", [".github/workflows/ci.yml"])]);

    const first = await fx.tick();

    expect(first).toMatchObject({ status: "continue", outcome: "dispatched" });
    expect(first.created.map((item) => [item.state, item.risk])).toEqual([["awaiting_approval", "high"]]);
    const id = workIdAt(first, 0);
    expect(first.awaiting_approval).toEqual([id]);
    expect(first.next_steps).toContain(`omf work approve ${id}`);
    expect(reportText(fx, first)).toContain(`omf work approve ${id}`);
    expect(lastTickEvents(fx).find((e) => e.type === "work.created")?.payload).toMatchObject({
      work_id: id,
      state: "awaiting_approval",
      risk_class: "high",
    });

    fx.clock.advance(MINUTE);
    const second = await fx.tick();
    expect(second).toMatchObject({ status: "continue", outcome: "wip_full" });
    expect(second.awaiting_approval).toEqual([id]);
    expect(fx.reconciler.calls).toBe(1);
  });

  it("excludes a hand-edited item from the open count and reports it", async () => {
    const fx = setupTick({ maxOpen: 1 });
    fx.reconciler.reply([candidateOf("Change the release pipeline", [".github/workflows/ci.yml"])]);
    const first = await fx.tick();
    const id = workIdAt(first, 0);

    // Claiming `ready` in item.md without a human work.approved in the ledger is not an approval (D27).
    const file = join(workItemDir(fx.location.dir, TICK_GOAL, id), "item.md");
    writeFileSync(file, readFileSync(file, "utf8").replace(/^state: .*$/m, "state: ready"));
    fx.reconciler.reply([candidateOf("Cache the render path")]);
    fx.clock.advance(MINUTE);
    // The excluded item leaves the verified state unchanged, which the stall guard (Task 13) would call no
    // progress; a new measurement makes this a different state, so the test keeps asking about the exclusion.
    writeFileSync(join(fx.repo, "bench", "p95.value"), "311\n");

    const second = await fx.tick();

    expect(second).toMatchObject({ status: "continue", outcome: "dispatched" });
    expect(fx.reconciler.calls).toBe(2);
    expect(second.awaiting_approval).toEqual([]);
    expect(second.next_steps).toContain(`omf work list ${TICK_GOAL}`);
  });
});
