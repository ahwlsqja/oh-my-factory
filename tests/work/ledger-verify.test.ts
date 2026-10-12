import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMarkdownStore, workItemDir } from "../../src/adapters/state-markdown.js";
import { Ledger } from "../../src/core/ledger.js";
import { verifiedItems, verifyItemAgainstLedger } from "../../src/work/ledger-verify.js";
import type { WorkItem, WorkItemFront } from "../../src/work/types.js";
import { makeTempDir } from "../helpers/tmp.js";
import { HIGH_RISK, T1, appendWorkEvent, createRecorded, makeNewItem, rewriteItem } from "../helpers/work.js";

function fixture() {
  const projectDir = makeTempDir("omf-verify-");
  return { projectDir, ledger: new Ledger(projectDir), store: createMarkdownStore(projectDir) };
}

const verdict = (ledger: Ledger, item: WorkItem, patch: Partial<WorkItemFront> = {}) =>
  verifyItemAgainstLedger({ ...item.front, ...patch }, ledger.readVerified());

describe("verifyItemAgainstLedger", () => {
  it("accepts the legitimate flows: create, approve, veto and cancel through the verbs plus events", () => {
    const { ledger, store } = fixture();
    const normal = createRecorded(ledger, store, makeNewItem({ title: "Cache the render path" }));
    const gated = createRecorded(ledger, store, makeNewItem({ title: "Update the CI workflow", risk: HIGH_RISK }));
    expect(verdict(ledger, normal)).toEqual({ ok: true });
    expect(verdict(ledger, gated)).toEqual({ ok: true });

    appendWorkEvent(ledger, "work.approved", "human:dev", gated);
    expect(verdict(ledger, gated, { state: "ready" })).toEqual({ ok: true });

    appendWorkEvent(ledger, "work.vetoed", "human:dev", normal, { reason: "no" });
    expect(verdict(ledger, normal, { state: "vetoed" })).toEqual({ ok: true });

    appendWorkEvent(ledger, "work.cancelled", "omf", gated, { cause: "goal_cancelled" });
    expect(verdict(ledger, gated, { state: "cancelled" })).toEqual({ ok: true });
  });

  it("reports an item with no work.created event, and ignores events of other items", () => {
    const { ledger, store } = fixture();
    const other = createRecorded(ledger, store, makeNewItem({ title: "Cache the render path" }));
    const orphan = { ...other.front, work_id: "w-aaaaaaaaaaaa" };
    expect(verifyItemAgainstLedger(orphan, ledger.readVerified())).toEqual({ ok: false, reason: "no_created_event" });
    expect(verifyItemAgainstLedger(other.front, [])).toEqual({ ok: false, reason: "no_created_event" });
  });

  it("catches a hand-edited approval: awaiting_approval -> ready with no human work.approved", () => {
    const { ledger, store } = fixture();
    const gated = createRecorded(ledger, store, makeNewItem({ risk: HIGH_RISK }));
    expect(verdict(ledger, gated, { state: "ready" })).toEqual({ ok: false, reason: "approval_unrecorded" });
    expect(verdict(ledger, gated, { state: "in_progress" })).toEqual({ ok: false, reason: "approval_unrecorded" });
  });

  it("does not count a work.approved whose actor is not a person", () => {
    const { ledger, store } = fixture();
    const gated = createRecorded(ledger, store, makeNewItem({ risk: HIGH_RISK }));
    appendWorkEvent(ledger, "work.approved", "omf", gated);
    appendWorkEvent(ledger, "work.approved", "agent:claude", gated);
    expect(verdict(ledger, gated, { state: "ready" })).toEqual({ ok: false, reason: "approval_unrecorded" });
  });

  it("accepts an item still awaiting approval after its approval was recorded (crash between event and file)", () => {
    const { ledger, store } = fixture();
    const gated = createRecorded(ledger, store, makeNewItem({ risk: HIGH_RISK }));
    appendWorkEvent(ledger, "work.approved", "human:dev", gated);
    expect(verdict(ledger, gated)).toEqual({ ok: true });
  });

  it("catches a hand-edited risk class", () => {
    const { ledger, store } = fixture();
    const gated = createRecorded(ledger, store, makeNewItem({ risk: HIGH_RISK }));
    const downgraded = { ...gated.front.risk, class: "normal" as const };
    expect(verdict(ledger, gated, { risk: downgraded })).toEqual({ ok: false, reason: "risk_mismatch" });
    expect(verdict(ledger, gated, { risk: downgraded, state: "ready" })).toEqual({ ok: false, reason: "risk_mismatch" });
  });

  it("catches vetoed and cancelled states the ledger never recorded", () => {
    const { ledger, store } = fixture();
    const item = createRecorded(ledger, store, makeNewItem());
    expect(verdict(ledger, item, { state: "vetoed" })).toEqual({ ok: false, reason: "veto_unrecorded" });
    expect(verdict(ledger, item, { state: "cancelled" })).toEqual({ ok: false, reason: "cancel_unrecorded" });
    appendWorkEvent(ledger, "work.vetoed", "omf", item, { reason: "not a person" });
    expect(verdict(ledger, item, { state: "vetoed" })).toEqual({ ok: false, reason: "veto_unrecorded" });
  });

  it("catches a vetoed or cancelled item that was hand-edited back open", () => {
    const { ledger, store } = fixture();
    const vetoed = createRecorded(ledger, store, makeNewItem({ title: "Cache the render path" }));
    appendWorkEvent(ledger, "work.vetoed", "human:dev", vetoed, { reason: "no" });
    expect(verdict(ledger, vetoed, { state: "ready" })).toEqual({ ok: false, reason: "state_mismatch" });
    const gated = createRecorded(ledger, store, makeNewItem({ title: "Update the CI workflow", risk: HIGH_RISK }));
    appendWorkEvent(ledger, "work.cancelled", "human:dev", gated, { cause: "manual" });
    expect(verdict(ledger, gated, { state: "awaiting_approval" })).toEqual({ ok: false, reason: "state_mismatch" });
  });

  it("catches an item created ready that was hand-edited to awaiting_approval", () => {
    const { ledger, store } = fixture();
    const item = createRecorded(ledger, store, makeNewItem());
    expect(verdict(ledger, item, { state: "awaiting_approval" })).toEqual({ ok: false, reason: "state_mismatch" });
  });

  it("lets a ready item move through the W states M3 adds", () => {
    const { ledger, store } = fixture();
    const item = createRecorded(ledger, store, makeNewItem());
    for (const state of ["in_progress", "awaiting_review", "done", "failed"] as const) {
      expect(verdict(ledger, item, { state }), state).toEqual({ ok: true });
    }
  });
});

describe("verifiedItems", () => {
  it("keeps hand-edited and unreadable items out of the item set and reports why", () => {
    const { projectDir, ledger, store } = fixture();
    const good = createRecorded(ledger, store, makeNewItem({ title: "Cache the render path" }));
    const gated = createRecorded(ledger, store, makeNewItem({ title: "Update the CI workflow", risk: HIGH_RISK }));
    rewriteItem(gated, { state: "ready" });
    const junkDir = workItemDir(projectDir, "g-fast", "w-0123456789ab");
    mkdirSync(junkDir, { recursive: true });
    writeFileSync(`${junkDir}/item.md`, "not a work item");

    // The raw store trusts the files: it would hand the forged item to dispatch as ready.
    expect(store.fetchWorkItemsByStates("g-fast", ["ready"]).map((item) => item.front.work_id).sort()).toEqual(
      [good.front.work_id, gated.front.work_id].sort(),
    );

    const result = verifiedItems(store, ledger.readVerified(), "g-fast");
    expect(result.items.map((item) => item.front.work_id)).toEqual([good.front.work_id]);
    expect(result.malformed.map((entry) => [entry.work_id, entry.reason.split(":")[0]])).toEqual(
      expect.arrayContaining([
        [gated.front.work_id, "approval_unrecorded"],
        ["w-0123456789ab", "item.md unreadable"],
      ]),
    );
    expect(result.malformed).toHaveLength(2);
  });

  it("returns the item again once a person approves it through the ledger", () => {
    const { ledger, store } = fixture();
    const gated = createRecorded(ledger, store, makeNewItem({ risk: HIGH_RISK }));
    appendWorkEvent(ledger, "work.approved", "human:dev", gated);
    store.approveWorkItem(gated.front.work_id, "human:dev", T1);
    const result = verifiedItems(store, ledger.readVerified(), "g-fast");
    expect(result.items.map((item) => item.front.state)).toEqual(["ready"]);
    expect(result.malformed).toEqual([]);
  });
});
