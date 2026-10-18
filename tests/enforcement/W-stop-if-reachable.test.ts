// covers: F10.wip-and-stop-if
import { describe, expect, it } from "vitest";
import { terminate } from "../../src/goal/lifecycle.js";
import { verifiedItems } from "../../src/work/ledger-verify.js";
import { TICK_GOAL, type TickFixture, ledgerEvents, seedWorkItem, setupTick } from "../helpers/tick.js";
import { begin, crashAfter, runWhole, startOnly, stateOf, wCode, wTrail } from "../helpers/w-flow.js";

// Spec §6.1: no new work is dispatched while three or more evidence reports are unreviewed. Before M3 no
// code wrote `awaiting_review`, so the rule could only be tested with hand-edited fixtures. Here the items
// get there through real runs, and the tick must stop before it calls the model or spends a round.
function submitted(fx: TickFixture, title: string, outcome: "success" | "flawed"): string {
  const workId = seedWorkItem(fx, { title });
  const result = runWhole(
    fx,
    workId,
    outcome === "success"
      ? { outcome, exhausted: false, reason_code: null }
      : { outcome, exhausted: false, reason_code: "station_error" },
  );
  expect(result).toMatchObject({ applied: true });
  expect(stateOf(fx, workId)).toBe("awaiting_review");
  return workId;
}

function consumed(fx: TickFixture): number {
  return ledgerEvents(fx).filter((event) => event.type === "budget.consumed").length;
}

describe("W-stop-if-reachable", () => {
  it("three real runs that end in awaiting_review stop the next tick before any model call or round", async () => {
    const fx = setupTick();
    submitted(fx, "Review pile alpha", "success");
    submitted(fx, "Review pile beta", "flawed");
    submitted(fx, "Review pile gamma", "flawed");

    const result = await fx.tick();

    expect(result).toMatchObject({
      status: "continue",
      outcome: "back_pressure",
      reason_code: "stop_if_unreviewed_evidence",
      reconciled: false,
    });
    expect(fx.reconciler.calls).toBe(0);
    expect(consumed(fx)).toBe(0);
  });

  it("two submitted items and one parked item do not trip STOP_IF; the parked one is open work", async () => {
    const fx = setupTick();
    submitted(fx, "Review pile alpha", "success");
    submitted(fx, "Review pile beta", "flawed");
    const parked = seedWorkItem(fx, { title: "Parked item" });
    runWhole(fx, parked, { outcome: "blocked", exhausted: false, reason_code: "gate_blocked" });
    expect(stateOf(fx, parked)).toBe("in_progress");

    const result = await fx.tick();

    expect(result).toMatchObject({ outcome: "wip_full", reason_code: "max_open_work_items" });
    expect(fx.reconciler.calls).toBe(0);
  });

  it("a repairable awaiting_review target counts toward STOP_IF", async () => {
    const fx = setupTick();
    submitted(fx, "Review pile alpha", "success");
    submitted(fx, "Review pile beta", "flawed");
    const crashed = seedWorkItem(fx, { title: "Crashed after submit" });
    startOnly(fx, crashed);
    crashAfter(fx, crashed, "submitted");
    expect(stateOf(fx, crashed)).toBe("in_progress"); // before: the file does not say awaiting_review yet

    const result = await fx.tick();

    expect(result).toMatchObject({ outcome: "back_pressure", reason_code: "stop_if_unreviewed_evidence" });
    expect(fx.reconciler.calls).toBe(0);
  });

  it("an exhausted run that failed its item adds nothing to the pile", async () => {
    const fx = setupTick();
    submitted(fx, "Review pile alpha", "success");
    submitted(fx, "Review pile beta", "flawed");
    const failed = seedWorkItem(fx, { title: "Failed item" });
    runWhole(fx, failed, { outcome: "blocked", exhausted: true, reason_code: "budget_exhausted" });
    expect(stateOf(fx, failed)).toBe("failed");

    const result = await fx.tick();

    expect(result.outcome).not.toBe("back_pressure");
    expect(result).toMatchObject({ outcome: "wip_full" }); // failed is terminal, so only the two awaiting items are open
    expect(fx.reconciler.calls).toBe(0);
  });

  it("a repairable item fills the WIP cap, so the tick offers the model no extra candidate", async () => {
    const fx = setupTick({ maxOpen: 1 });
    const crashed = seedWorkItem(fx, { title: "Crashed after start" });
    crashAfter(fx, crashed, "started");
    // Control: the verifier keeps this item out of `items`, so only the repairable count can fill the cap.
    expect(verifiedItems(fx.store, ledgerEvents(fx), TICK_GOAL).items).toEqual([]);

    const result = await fx.tick();

    expect(result).toMatchObject({ outcome: "wip_full", reason_code: "max_open_work_items" });
    expect(fx.reconciler.calls).toBe(0);
    expect(consumed(fx)).toBe(0);
  });

  it("a goal that is blocked_on_user cannot start a run", () => {
    const fx = setupTick();
    const workId = seedWorkItem(fx, { title: "Waiting item" });
    terminate(fx.ledger, TICK_GOAL, "blocked_on_user", null, "no_progress");

    expect(wCode(() => begin(fx, workId))).toBe("governance");
    expect(wTrail(fx, workId)).toEqual([]);
    expect(stateOf(fx, workId)).toBe("ready");
  });
});
