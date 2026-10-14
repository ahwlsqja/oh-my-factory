import { describe, expect, it } from "vitest";
import { createMarkdownStore } from "../../src/adapters/state-markdown.js";
import { Ledger } from "../../src/core/ledger.js";
import { verifiedItems } from "../../src/work/ledger-verify.js";
import { setupGoal } from "../helpers/goal.js";
import { TICK_GOAL, seedWorkItem, setupTick } from "../helpers/tick.js";
import { createRecorded, makeNewItem, recordW, rewriteItem } from "../helpers/work.js";

// Spec §6.2 and §11 rule 5: item.md is a projection, and the ledger is the authority (M3b1-D4). A person with
// a text editor must not be able to move an item into a W state: the state needs an `omf` W event, and an item
// without one is malformed, so dispatch, the WIP cap and STOP_IF never see it.
function fixture() {
  const fx = setupGoal();
  const store = createMarkdownStore(fx.location.dir);
  return { fx, store, ledger: new Ledger(fx.location.dir) };
}

const WORK_STATES = ["in_progress", "awaiting_review", "failed", "done"] as const;

describe("W-ledger-requires-w-event", () => {
  it("a hand-edited W state, done included, is malformed and absent from the verified items", () => {
    const { store, ledger } = fixture();
    const items = WORK_STATES.map((state, index) => {
      const item = createRecorded(ledger, store, makeNewItem({ goalId: "g-fast", title: `Hand edited to ${state} ${index}` }));
      rewriteItem(item, { state });
      return item;
    });
    const result = verifiedItems(store, ledger.readVerified(), "g-fast");
    expect(result.items).toEqual([]);
    expect(result.malformed.map((entry) => entry.reason).sort()).toEqual(WORK_STATES.map(() => "w_event_missing"));
    // Positive control: the raw store trusts the files and would hand all of them to dispatch.
    expect(store.fetchAllWorkItems("g-fast")).toHaveLength(items.length);
  });

  it("a W event written by a person or an agent does not satisfy the state", () => {
    const { store, ledger } = fixture();
    const item = createRecorded(ledger, store, makeNewItem({ goalId: "g-fast" }));
    for (const actor of ["human:dev", "agent:claude"]) {
      ledger.append({
        actor,
        type: "work.started",
        payload: { goal_id: "g-fast", work_id: item.front.work_id, run_id: "r-20261012T100000Z-0001", from: "ready" },
      });
    }
    rewriteItem(item, { state: "in_progress" });
    expect(verifiedItems(store, ledger.readVerified(), "g-fast").malformed.map((entry) => entry.reason)).toEqual(["w_event_missing"]);
  });

  it("the same file with an omf event is verified (the control that makes the cases above mean something)", () => {
    const { store, ledger } = fixture();
    const item = createRecorded(ledger, store, makeNewItem({ goalId: "g-fast" }));
    recordW(ledger, "work.started", item);
    rewriteItem(item, { state: "in_progress" });
    const result = verifiedItems(store, ledger.readVerified(), "g-fast");
    expect(result.items.map((entry) => entry.front.state)).toEqual(["in_progress"]);
    expect(result.malformed).toEqual([]);
  });

  it("three hand-edited awaiting_review items do not trip STOP_IF; three with their events do", async () => {
    const forged = setupTick();
    for (const title of ["Forged alpha", "Forged beta", "Forged gamma"]) {
      const item = createRecorded(forged.ledger, forged.store, makeNewItem({ goalId: TICK_GOAL, title }));
      rewriteItem(item, { state: "awaiting_review" });
    }
    expect((await forged.tick()).outcome).not.toBe("back_pressure");

    const honest = setupTick();
    for (const title of ["Honest alpha", "Honest beta", "Honest gamma"]) seedWorkItem(honest, { title, state: "awaiting_review" });
    expect((await honest.tick()).outcome).toBe("back_pressure");
  });
});
