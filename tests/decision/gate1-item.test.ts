import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gate1ForItem } from "../../src/decision/gate1-item.js";
import { goalLockFile } from "../../src/goal/goal-lock.js";
import {
  NOW,
  addOpen,
  closeInterface,
  errorCode,
  reportAt,
  resolveOpen,
  setupDecisionItem,
} from "../helpers/decision-fixture.js";

// `gate1ForItem` is the library form of what `omf decide` computes in `snapshotOf`: the sequencer's GATE-1 adapter
// calls it with the events it already verified, so it must never disagree with the decision CLI.
describe("gate1ForItem", () => {
  it("returns the same verdict as `decideReport` for a fresh item, an open decision and a settled item", () => {
    const f = setupDecisionItem();
    const seen = () => gate1ForItem(f.fx.location, f.item, f.fx.ledger.readVerified(), NOW).result;

    expect(seen()).toEqual({ status: "blocked_on_user", j: "J2", reasons: [{ code: "interface_missing" }] });
    expect(seen()).toEqual(reportAt(f, NOW).gate);

    closeInterface(f);
    addOpen(f, "d-cache");
    expect(seen()).toEqual(reportAt(f, NOW).gate);
    expect(seen().status).toBe("blocked_on_user");

    resolveOpen(f, "d-cache");
    expect(seen()).toEqual({ status: "pass" });
    expect(seen()).toEqual(reportAt(f, NOW).gate);
  });

  it("returns the scope of the item", () => {
    const f = setupDecisionItem();
    const { scope } = gate1ForItem(f.fx.location, f.item, f.fx.ledger.readVerified(), NOW);
    expect(scope).toEqual({ goal_id: f.fx.goalId, work_id: f.workId });
  });

  it("throws when the goal has no lock, so a missing lock can never read as a pass", () => {
    const f = setupDecisionItem();
    closeInterface(f);
    rmSync(goalLockFile(f.fx.location.dir, f.fx.goalId));
    expect(errorCode(() => gate1ForItem(f.fx.location, f.item, f.fx.ledger.readVerified(), NOW))).toBe(
      "goal_not_locked",
    );
  });
});
