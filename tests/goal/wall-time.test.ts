import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/core/ledger.js";
import { latestApproval, lockGoal, readGoalLock } from "../../src/goal/goal-lock.js";
import { raiseWallTime, wallTimeLimitMs } from "../../src/goal/wall-time.js";
import { type GoalFixture, approveLegacy, setupGoal } from "../helpers/goal.js";

const H = 3_600_000;

function limit(fx: GoalFixture): number {
  const events = new Ledger(fx.location.dir).readVerified();
  return wallTimeLimitMs(events, "g-fast", latestApproval(events, "g-fast")!, readGoalLock(fx.location.dir, "g-fast"));
}
const raised = (fx: GoalFixture): number =>
  new Ledger(fx.location.dir).readVerified().filter((e) => e.type === "goal.wall_time_raised").length;

describe("raiseWallTime", () => {
  it("is human only and writes nothing otherwise", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    expect(() => raiseWallTime(fx.ledger, "g-fast", "2h", "omf")).toThrow(/only a person raises wall time \(J8\); actor was omf/);
    expect(() => raiseWallTime(fx.ledger, "g-fast", "2h", "agent:claude")).toThrow(/only a person/);
    expect(raised(fx)).toBe(0);
  });

  it("refuses a duration that goal.md could not hold and an unapproved goal", () => {
    const fx = setupGoal();
    expect(() => raiseWallTime(fx.ledger, "g-fast", "2h", "human:dev")).toThrow(/goal g-fast is not approved/);
    lockGoal(fx.location, "g-fast", "human:dev");
    expect(() => raiseWallTime(fx.ledger, "g-fast", "2 hours", "human:dev")).toThrow(/invalid duration/);
    expect(raised(fx)).toBe(0);
  });

  it("appends goal.wall_time_raised with the duration", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    raiseWallTime(fx.ledger, "g-fast", "2h", "human:dev");
    const event = new Ledger(fx.location.dir).readVerified().at(-1);
    expect(event).toMatchObject({ actor: "human:dev", type: "goal.wall_time_raised", payload: { goal_id: "g-fast", by: "2h" } });
  });
});

describe("wallTimeLimitMs", () => {
  it("is the approved wall time when nothing was raised", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    expect(limit(fx)).toBe(72 * H);
  });

  it("adds every raise since the latest approval", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    raiseWallTime(fx.ledger, "g-fast", "24h", "human:dev");
    raiseWallTime(fx.ledger, "g-fast", "2h", "human:dev");
    expect(limit(fx)).toBe(98 * H);
  });

  it("does not carry a raise over a re-approval, which is a new J1 look at the whole goal", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    raiseWallTime(fx.ledger, "g-fast", "24h", "human:dev");
    lockGoal(fx.location, "g-fast", "human:dev");
    expect(limit(fx)).toBe(72 * H);
    raiseWallTime(fx.ledger, "g-fast", "1h", "human:dev");
    expect(limit(fx)).toBe(73 * H);
  });

  it("falls back to the goal lock for an approval from before wall time was recorded", () => {
    const fx = setupGoal();
    approveLegacy(fx);
    expect(latestApproval(new Ledger(fx.location.dir).readVerified(), "g-fast")?.wall_time).toBeNull();
    expect(limit(fx)).toBe(72 * H);
  });

  it("stops the line on a raise written by a non-person or with a bad duration", () => {
    const forged = setupGoal();
    lockGoal(forged.location, "g-fast", "human:dev");
    forged.ledger.append({ actor: "agent:claude", type: "goal.wall_time_raised", payload: { goal_id: "g-fast", by: "24h" } });
    expect(() => limit(forged)).toThrow(/invalid goal\.wall_time_raised event at seq \d+/);

    const bad = setupGoal();
    lockGoal(bad.location, "g-fast", "human:dev");
    bad.ledger.append({ actor: "human:dev", type: "goal.wall_time_raised", payload: { goal_id: "g-fast", by: "soon" } });
    expect(() => limit(bad)).toThrow(/invalid goal\.wall_time_raised event/);
  });

  it("ignores a raise recorded for another goal", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    fx.ledger.append({ actor: "human:dev", type: "goal.wall_time_raised", payload: { goal_id: "g-other", by: "24h" } });
    expect(limit(fx)).toBe(72 * H);
  });
});
