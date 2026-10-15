import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/core/ledger.js";
import { isFinal, runStateFromEvents } from "../../src/goal/run-state.js";
import { appendEscalation, appendGoalEvent } from "../helpers/loop-events.js";
import { makeTempDir } from "../helpers/tmp.js";

const G = "g-fast";
const newLedger = (): Ledger => new Ledger(makeTempDir("omf-ledger-"));
const stateOf = (ledger: Ledger) => runStateFromEvents(ledger.readVerified(), G);
const terminated = (ledger: Ledger, state: string, actor = "omf") =>
  appendGoalEvent(ledger, "goal.terminated", G, actor, { tick_id: null, state, reason_code: "test" });

describe("runStateFromEvents", () => {
  it("is running with no loop events, and counts goal.tick_started of this goal only", () => {
    const ledger = newLedger();
    expect(stateOf(ledger)).toEqual({
      status: "running",
      since: null,
      reason_code: null,
      open_escalation: null,
      ticks: 0,
    });
    appendGoalEvent(ledger, "goal.tick_started", G, "omf", {
      tick_id: "t-1",
      regime: 1,
      runner: "host",
      config_sha256: "x",
    });
    appendGoalEvent(ledger, "goal.tick_started", "g-other", "omf", {
      tick_id: "t-2",
      regime: 1,
      runner: "host",
      config_sha256: "x",
    });
    expect(stateOf(ledger).ticks).toBe(1);
  });

  it("goal.escalated + goal.terminated(blocked_on_user) blocks the goal and keeps the escalation", () => {
    const ledger = newLedger();
    appendEscalation(ledger, G, "J6", "no_progress");
    const state = stateOf(ledger);
    expect(state.status).toBe("blocked_on_user");
    expect(state.reason_code).toBe("no_progress");
    expect(state.since).not.toBeNull();
    expect(state.open_escalation).toMatchObject({
      tick_id: "t-test",
      j: "J6",
      reason_code: "no_progress",
      signature: null,
      question: "question?",
      options: ["a", "b"],
      default: "stay stopped",
    });
  });

  it("a goal.escalated with no goal.terminated still projects as blocked_on_user (a crash between the two appends)", () => {
    const ledger = newLedger();
    appendEscalation(ledger, G, "J8", "rounds_exhausted", { terminate: false });
    expect(stateOf(ledger)).toMatchObject({ status: "blocked_on_user", open_escalation: { j: "J8" } });
  });

  it("goal.resumed clears blocked_on_user and the open escalation", () => {
    const ledger = newLedger();
    appendEscalation(ledger, G, "J6", "repeated_signature");
    appendGoalEvent(ledger, "goal.resumed", G, "human:dev", { from: "blocked_on_user" });
    expect(stateOf(ledger)).toMatchObject({ status: "running", reason_code: null, open_escalation: null });
  });

  it("goal.resumed clears failed, and nothing else does", () => {
    const ledger = newLedger();
    terminated(ledger, "failed");
    expect(stateOf(ledger)).toMatchObject({ status: "failed", reason_code: "test" });
    appendGoalEvent(ledger, "goal.approved", G, "human:dev");
    expect(stateOf(ledger).status).toBe("failed");
    appendGoalEvent(ledger, "goal.resumed", G, "human:dev", { from: "failed" });
    expect(stateOf(ledger).status).toBe("running");
  });

  it.each(["goal_not_approved", "reapproval_required", "stale_goal"])(
    "goal.approved clears the J1 block %s",
    (reason) => {
      const ledger = newLedger();
      appendEscalation(ledger, G, "J1", reason);
      appendGoalEvent(ledger, "goal.approved", G, "human:dev");
      expect(stateOf(ledger)).toMatchObject({ status: "running", open_escalation: null });
    },
  );

  it.each([
    ["J6", "no_progress"],
    ["J8", "wall_time_exceeded"],
  ] as const)("goal.approved leaves a %s block (%s) blocked: resume is still required", (j, reason) => {
    const ledger = newLedger();
    appendEscalation(ledger, G, j, reason);
    appendGoalEvent(ledger, "goal.approved", G, "human:dev");
    expect(stateOf(ledger)).toMatchObject({ status: "blocked_on_user", open_escalation: { j, reason_code: reason } });
  });

  it("budget raises and wall-time raises do not change the status (J8 needs a resume afterwards)", () => {
    const ledger = newLedger();
    appendEscalation(ledger, G, "J8", "rounds_exhausted");
    appendGoalEvent(ledger, "budget.raised", G, "human:dev", { kind: "rounds", amount: 5 });
    appendGoalEvent(ledger, "goal.wall_time_raised", G, "human:dev", { by: "2h" });
    expect(stateOf(ledger)).toMatchObject({ status: "blocked_on_user", open_escalation: { j: "J8" } });
  });

  it("nothing clears finish or cancelled", () => {
    for (const final of ["finish", "cancelled"] as const) {
      const ledger = newLedger();
      terminated(ledger, final, final === "cancelled" ? "human:dev" : "omf");
      appendGoalEvent(ledger, "goal.resumed", G, "human:dev", { from: "failed" });
      appendGoalEvent(ledger, "goal.approved", G, "human:dev");
      appendEscalation(ledger, G, "J6", "no_progress");
      expect(stateOf(ledger).status).toBe(final);
      expect(isFinal(stateOf(ledger).status)).toBe(true);
    }
    expect(isFinal("running")).toBe(false);
    expect(isFinal("blocked_on_user")).toBe(false);
    expect(isFinal("failed")).toBe(false);
  });

  it("ignores the events of other goals", () => {
    const ledger = newLedger();
    appendEscalation(ledger, "g-other", "J6", "no_progress");
    expect(stateOf(ledger).status).toBe("running");
  });

  it("refuses a goal.resumed, goal.approved or cancelled goal.terminated by a non-person", () => {
    const resumed = newLedger();
    appendGoalEvent(resumed, "goal.resumed", G, "omf", { from: "failed" });
    expect(() => stateOf(resumed)).toThrow(/invalid goal\.resumed event at seq 1/);

    const approved = newLedger();
    appendGoalEvent(approved, "goal.approved", G, "omf");
    expect(() => stateOf(approved)).toThrow(/invalid goal\.approved event at seq 1/);

    const cancelled = newLedger();
    terminated(cancelled, "cancelled", "omf");
    expect(() => stateOf(cancelled)).toThrow(/invalid goal\.terminated event at seq 1/);
  });

  it("refuses a malformed escalation or termination payload", () => {
    const escalated = newLedger();
    appendGoalEvent(escalated, "goal.escalated", G, "omf", { tick_id: "t-1", j: "J9" });
    expect(() => stateOf(escalated)).toThrow(/invalid goal\.escalated event at seq 1: malformed payload/);

    const ended = newLedger();
    appendGoalEvent(ended, "goal.terminated", G, "omf", { tick_id: null, state: "paused", reason_code: "x" });
    expect(() => stateOf(ended)).toThrow(/invalid goal\.terminated event at seq 1: malformed payload/);
  });
});
