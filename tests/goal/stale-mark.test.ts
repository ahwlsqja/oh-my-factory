import { describe, expect, it } from "vitest";
import type { LedgerEvent } from "../../src/core/ledger.js";
import { isMarkedStale, staleReason } from "../../src/goal/stale-mark.js";

const ZERO = "0".repeat(64);
function ev(seq: number, type: string, payload: Record<string, unknown>, actor = "omf"): LedgerEvent {
  return { schema_version: 1, seq, prev_hash: ZERO, ts: "2026-10-12T00:00:00.000Z", actor, type, payload, hash: ZERO };
}
const approved = (seq: number, goal = "g-fast"): LedgerEvent => ev(seq, "goal.approved", { goal_id: goal, regime: seq }, "human:dev");
const stale = (seq: number, tripped: unknown, goal = "g-fast"): LedgerEvent => ev(seq, "goal.stale", { goal_id: goal, tripped });

describe("stale mark", () => {
  it("is not set without a goal.stale event", () => {
    expect(isMarkedStale([], "g-fast")).toBe(false);
    expect(staleReason([approved(1)], "g-fast")).toBeNull();
  });

  it("is set by a goal.stale after the latest approval and names what tripped", () => {
    const events = [approved(1), stale(2, ["age", "commits"])];
    expect(isMarkedStale(events, "g-fast")).toBe(true);
    expect(staleReason(events, "g-fast")).toBe("goal marked stale (age,commits)");
  });

  it("is cleared by a later goal.approved", () => {
    const events = [approved(1), stale(2, ["age"]), approved(3)];
    expect(isMarkedStale(events, "g-fast")).toBe(false);
    expect(staleReason(events, "g-fast")).toBeNull();
    expect(isMarkedStale([...events, stale(4, ["target_move"])], "g-fast")).toBe(true);
  });

  it("reports the latest mark and ignores other goals", () => {
    const events = [approved(1), stale(2, ["age"]), stale(3, ["target_move"]), stale(4, ["commits"], "g-other"), approved(5, "g-other")];
    expect(staleReason(events, "g-fast")).toBe("goal marked stale (target_move)");
    expect(isMarkedStale(events, "g-other")).toBe(false);
  });

  it("stops the line on a malformed goal.stale", () => {
    for (const tripped of [[], ["nope"], "age", undefined]) {
      expect(() => isMarkedStale([approved(1), stale(2, tripped)], "g-fast")).toThrow(/invalid goal\.stale event at seq 2/);
    }
  });
});
