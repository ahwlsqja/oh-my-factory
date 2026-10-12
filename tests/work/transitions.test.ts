import { describe, expect, it } from "vitest";
import { TRANSITIONS, canTransition } from "../../src/work/transitions.js";
import { OPEN_STATES, TERMINAL_WORK_STATES, type WorkState } from "../../src/work/types.js";

const ALL: readonly WorkState[] = [...OPEN_STATES, ...TERMINAL_WORK_STATES];

describe("work item transitions", () => {
  it("is exactly the table in the design", () => {
    expect(TRANSITIONS).toEqual({
      ready: ["in_progress", "vetoed", "cancelled"],
      awaiting_approval: ["ready", "vetoed", "cancelled"],
      in_progress: ["awaiting_review", "failed", "vetoed", "cancelled"],
      awaiting_review: ["done", "failed", "vetoed", "cancelled"],
      done: [],
      failed: [],
      vetoed: [],
      cancelled: [],
    });
  });

  it("lets a person veto or cancel from every open state, in_progress included", () => {
    for (const from of OPEN_STATES) {
      expect(canTransition(from, "vetoed"), `${from} -> vetoed`).toBe(true);
      expect(canTransition(from, "cancelled"), `${from} -> cancelled`).toBe(true);
    }
  });

  it("allows nothing out of a terminal state", () => {
    for (const from of TERMINAL_WORK_STATES) {
      for (const to of ALL) expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
    }
  });

  it("opens a gated item only through ready: awaiting_approval cannot start work", () => {
    expect(canTransition("awaiting_approval", "ready")).toBe(true);
    expect(canTransition("awaiting_approval", "in_progress")).toBe(false);
    expect(canTransition("awaiting_approval", "done")).toBe(false);
  });

  it("has no self transitions and mentions every state", () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...ALL].sort());
    for (const state of ALL) expect(canTransition(state, state), state).toBe(false);
  });
});
