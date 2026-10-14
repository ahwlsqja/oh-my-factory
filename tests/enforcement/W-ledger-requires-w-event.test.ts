import { describe, expect, it } from "vitest";
import { createMarkdownStore } from "../../src/adapters/state-markdown.js";
import { Ledger } from "../../src/core/ledger.js";
import { verifiedItems } from "../../src/work/ledger-verify.js";
import { failItem, repairItem, startItem, submitForReview } from "../../src/work/w-verbs.js";
import { setupGoal } from "../helpers/goal.js";
import { TICK_GOAL, seedWorkItem, setupTick } from "../helpers/tick.js";
import { W_RUN, type WFixture, setupW, wCodeOf } from "../helpers/w-verbs-fixture.js";
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

/**
 * Verb level (M3b1-D2, D4): a crash can leave the ledger one W edge ahead of item.md. Only `repairItem`
 * may heal that, and nothing may heal a file that is ahead of the ledger (W-file-ahead-malformed).
 */
describe("W verbs on an item whose file and ledger disagree", () => {
  const ahead: { name: string; from: string; to: string; prepare: (fx: WFixture) => number }[] = [
    {
      name: "work.started is in the ledger and item.md still says ready",
      from: "ready",
      to: "in_progress",
      prepare: (fx) => fx.appendOnly({ type: "work.started", payload: { ...fx.scope, from: "ready" } }).seq,
    },
    {
      name: "work.submitted is in the ledger and item.md still says in_progress",
      from: "in_progress",
      to: "awaiting_review",
      prepare: (fx) => {
        startItem(fx.ctx, fx.claim, fx.workId, W_RUN);
        return fx.appendOnly({
          type: "work.submitted",
          payload: { ...fx.scope, outcome: "success", recommendation: "merge_recommended" },
        }).seq;
      },
    },
    {
      name: "work.failed is in the ledger and item.md still says in_progress",
      from: "in_progress",
      to: "failed",
      prepare: (fx) => {
        startItem(fx.ctx, fx.claim, fx.workId, W_RUN);
        return fx.appendOnly({
          type: "work.failed",
          payload: { ...fx.scope, outcome: "flawed", reason_code: "budget_exhausted" },
        }).seq;
      },
    },
  ];
  for (const c of ahead) {
    it(`${c.name}: start, submit and fail refuse, repairItem heals it with a work.repaired event`, () => {
      const fx = setupW();
      const seq = c.prepare(fx);
      expect(fx.fresh().front.state).toBe(c.from);
      const before = fx.ledgerText();
      expect([
        wCodeOf(() => startItem(fx.ctx, fx.claim, fx.workId, W_RUN)),
        wCodeOf(() => submitForReview(fx.ctx, fx.claim, fx.workId, W_RUN, "success")),
        wCodeOf(() => failItem(fx.ctx, fx.claim, fx.workId, W_RUN, { outcome: "flawed", reason_code: "station_error" })),
      ]).toEqual(["malformed", "malformed", "malformed"]);
      expect(fx.ledgerText()).toBe(before);

      const repaired = repairItem(fx.ctx, fx.claim, fx.workId, W_RUN);
      expect(repaired?.front.state).toBe(c.to);
      expect(fx.events().at(-1)).toMatchObject({
        actor: "omf",
        type: "work.repaired",
        payload: { ...fx.scope, from: c.from, to: c.to, source_seq: seq },
      });
      expect(fx.verdict()).toEqual({ ok: true });
      expect(repairItem(fx.ctx, fx.claim, fx.workId, W_RUN)).toBeNull();
    });
  }

  const behind: { name: string; prepare: (fx: WFixture) => void }[] = [
    { name: "a person edited item.md ahead of the ledger", prepare: (fx) => fx.handEdit("in_progress") },
    {
      name: "item.md is two edges behind the ledger",
      prepare: (fx) => {
        fx.appendOnly({ type: "work.started", payload: { ...fx.scope, from: "ready" } });
        fx.appendOnly({
          type: "work.submitted",
          payload: { ...fx.scope, outcome: "success", recommendation: "merge_recommended" },
        });
      },
    },
    {
      name: "item.md was edited to awaiting_review although the ledger says failed",
      prepare: (fx) => {
        startItem(fx.ctx, fx.claim, fx.workId, W_RUN);
        fx.appendOnly({ type: "work.failed", payload: { ...fx.scope, outcome: "flawed", reason_code: "budget_exhausted" } });
        fx.handEdit("awaiting_review");
      },
    },
  ];
  for (const c of behind) {
    it(`${c.name}: stays malformed, is never repaired and is never counted`, () => {
      const fx = setupW();
      c.prepare(fx);
      const ledgerBefore = fx.ledgerText();
      const itemBefore = fx.itemText();
      expect(fx.verdict()).toEqual({ ok: false, reason: "w_event_missing" });
      expect(wCodeOf(() => repairItem(fx.ctx, fx.claim, fx.workId, W_RUN))).toBe("malformed");
      expect(fx.ledgerText()).toBe(ledgerBefore);
      expect(fx.itemText()).toBe(itemBefore);
      const verified = fx.verified();
      expect(verified.items.map((item) => item.front.work_id)).toEqual([]);
      expect(verified.malformed.map((entry) => entry.reason)).toEqual(["w_event_missing"]);
    });
  }
});
