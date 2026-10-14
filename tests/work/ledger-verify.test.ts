import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMarkdownStore, workItemDir } from "../../src/adapters/state-markdown.js";
import { Ledger } from "../../src/core/ledger.js";
import { verifiedItems, verifyItemAgainstLedger } from "../../src/work/ledger-verify.js";
import type { WorkItem, WorkItemFront } from "../../src/work/types.js";
import { makeTempDir } from "../helpers/tmp.js";
import { HIGH_RISK, T1, appendWorkEvent, createRecorded, makeNewItem, recordW, rewriteItem } from "../helpers/work.js";

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
});

// Spec §6.2 and M3b1-D4: a W state needs its `omf` event, and a file exactly one W edge behind the ledger is
// repairable. Every case builds the ledger with recordW (what a run would have appended) and the file with
// the `state` patch, so the file and the ledger can disagree in exactly the way each test names.
describe("verifyItemAgainstLedger: W clauses", () => {
  const lastSeq = (ledger: Ledger): number => ledger.readVerified().at(-1)!.seq;

  it("needs the matching event for every W state, and never accepts done", () => {
    const { ledger, store } = fixture();
    const item = createRecorded(ledger, store, makeNewItem());
    for (const state of ["in_progress", "awaiting_review", "failed", "done"] as const) {
      expect(verdict(ledger, item, { state }), state).toEqual({ ok: false, reason: "w_event_missing" });
    }
    recordW(ledger, "work.started", item);
    recordW(ledger, "work.submitted", item);
    expect(verdict(ledger, item, { state: "done" })).toEqual({ ok: false, reason: "w_event_missing" });
  });

  it("accepts a full legal trail, parked from ready and from in_progress, and the events that change nothing", () => {
    const { ledger, store } = fixture();
    const item = createRecorded(ledger, store, makeNewItem());
    recordW(ledger, "work.parked", item); // never started: stays ready
    recordW(ledger, "work.claim_reclaimed", item);
    expect(verdict(ledger, item)).toEqual({ ok: true });
    recordW(ledger, "work.started", item);
    expect(verdict(ledger, item, { state: "in_progress" })).toEqual({ ok: true });
    recordW(ledger, "work.parked", item); // parked after start: stays in_progress
    recordW(ledger, "work.resumed", item);
    recordW(ledger, "work.repaired", item, { from: "ready", to: "in_progress", source_seq: 1 });
    expect(verdict(ledger, item, { state: "in_progress" })).toEqual({ ok: true });
    recordW(ledger, "work.submitted", item);
    expect(verdict(ledger, item, { state: "awaiting_review" })).toEqual({ ok: true });

    const failing = createRecorded(ledger, store, makeNewItem({ title: "Warm the cache" }));
    recordW(ledger, "work.started", failing);
    recordW(ledger, "work.failed", failing);
    expect(verdict(ledger, failing, { state: "failed" })).toEqual({ ok: true });
  });

  it("reports a trail out of order as w_trail_invalid", () => {
    const { ledger, store } = fixture();
    const skipped = createRecorded(ledger, store, makeNewItem({ title: "Skip the start" }));
    recordW(ledger, "work.submitted", skipped);
    expect(verdict(ledger, skipped)).toEqual({ ok: false, reason: "w_trail_invalid" });

    const twice = createRecorded(ledger, store, makeNewItem({ title: "Start twice" }));
    recordW(ledger, "work.started", twice);
    recordW(ledger, "work.started", twice);
    expect(verdict(ledger, twice, { state: "in_progress" })).toEqual({ ok: false, reason: "w_trail_invalid" });

    const resumed = createRecorded(ledger, store, makeNewItem({ title: "Resume a ready item" }));
    recordW(ledger, "work.resumed", resumed);
    expect(verdict(ledger, resumed)).toEqual({ ok: false, reason: "w_trail_invalid" });

    const broken = createRecorded(ledger, store, makeNewItem({ title: "Drop the run id" }));
    ledger.append({ actor: "omf", type: "work.started", payload: { goal_id: "g-fast", work_id: broken.front.work_id, from: "ready" } });
    expect(verdict(ledger, broken)).toEqual({ ok: false, reason: "w_trail_invalid" });
  });

  it("calls a file exactly one W edge behind the ledger repairable, with the edge's target and event", () => {
    const { ledger, store } = fixture();
    const item = createRecorded(ledger, store, makeNewItem());
    recordW(ledger, "work.started", item);
    expect(verdict(ledger, item)).toEqual({
      ok: false,
      reason: "w_repairable",
      repair_to: "in_progress",
      source_seq: lastSeq(ledger),
    });
    recordW(ledger, "work.submitted", item);
    expect(verdict(ledger, item, { state: "in_progress" })).toEqual({
      ok: false,
      reason: "w_repairable",
      repair_to: "awaiting_review",
      source_seq: lastSeq(ledger),
    });

    const failing = createRecorded(ledger, store, makeNewItem({ title: "Warm the cache" }));
    recordW(ledger, "work.started", failing);
    recordW(ledger, "work.failed", failing);
    expect(verdict(ledger, failing, { state: "in_progress" })).toEqual({
      ok: false,
      reason: "w_repairable",
      repair_to: "failed",
      source_seq: lastSeq(ledger),
    });
  });

  it("does not repair a file that is ahead, two edges behind, or hand-edited to a state the fold never had", () => {
    const { ledger, store } = fixture();
    const ahead = createRecorded(ledger, store, makeNewItem({ title: "File ahead" }));
    recordW(ledger, "work.started", ahead);
    expect(verdict(ledger, ahead, { state: "awaiting_review" })).toEqual({ ok: false, reason: "w_event_missing" });

    const far = createRecorded(ledger, store, makeNewItem({ title: "Two edges behind" }));
    recordW(ledger, "work.started", far);
    recordW(ledger, "work.submitted", far);
    expect(verdict(ledger, far, { state: "ready" })).toEqual({ ok: false, reason: "w_event_missing" });

    // TRANSITIONS lists awaiting_review -> failed for a person, but the fold's predecessor of `failed` is in_progress.
    const edited = createRecorded(ledger, store, makeNewItem({ title: "Hand edit" }));
    recordW(ledger, "work.started", edited);
    recordW(ledger, "work.failed", edited);
    expect(verdict(ledger, edited, { state: "awaiting_review" })).toEqual({ ok: false, reason: "w_event_missing" });
  });

  it("ignores a W event written by a person or an agent", () => {
    const { ledger, store } = fixture();
    const item = createRecorded(ledger, store, makeNewItem());
    for (const actor of ["human:dev", "agent:claude"]) {
      ledger.append({
        actor,
        type: "work.started",
        payload: { goal_id: "g-fast", work_id: item.front.work_id, run_id: "r-20261012T100000Z-0001", from: "ready" },
      });
    }
    expect(verdict(ledger, item, { state: "in_progress" })).toEqual({ ok: false, reason: "w_event_missing" });
    expect(verdict(ledger, item)).toEqual({ ok: true });
  });

  it("ignores W events after a veto", () => {
    const { ledger, store } = fixture();
    const item = createRecorded(ledger, store, makeNewItem());
    appendWorkEvent(ledger, "work.vetoed", "human:dev", item, { reason: "no" });
    recordW(ledger, "work.started", item); // a run lost the race to the veto
    expect(verdict(ledger, item, { state: "vetoed" })).toEqual({ ok: true });
    expect(verdict(ledger, item, { state: "in_progress" })).toEqual({ ok: false, reason: "state_mismatch" });
  });

  it("starts the fold at awaiting_approval for a high-risk item", () => {
    const { ledger, store } = fixture();
    const early = createRecorded(ledger, store, makeNewItem({ title: "Update the CI workflow", risk: HIGH_RISK }));
    recordW(ledger, "work.started", early); // before any approval
    expect(verdict(ledger, early)).toEqual({ ok: false, reason: "w_trail_invalid" });
    appendWorkEvent(ledger, "work.approved", "human:dev", early);
    expect(verdict(ledger, early, { state: "ready" })).toEqual({ ok: false, reason: "w_trail_invalid" });

    const late = createRecorded(ledger, store, makeNewItem({ title: "Update the lockfile", risk: HIGH_RISK }));
    appendWorkEvent(ledger, "work.approved", "human:dev", late);
    recordW(ledger, "work.started", late);
    expect(verdict(ledger, late, { state: "in_progress" })).toEqual({ ok: true });
    expect(verdict(ledger, late)).toEqual({ ok: false, reason: "w_trail_invalid" }); // an awaiting_approval file with a W trail
  });

  it("treats claim_reclaimed as neutral even while the item still awaits approval", () => {
    // beginRun records a reclaim and then refuses a not-yet-approved high-risk item; that trace must not poison the item.
    const { ledger, store } = fixture();
    const item = createRecorded(ledger, store, makeNewItem({ title: "Rotate the signing key", risk: HIGH_RISK }));
    recordW(ledger, "work.claim_reclaimed", item);
    expect(verdict(ledger, item)).toEqual({ ok: true });
    appendWorkEvent(ledger, "work.approved", "human:dev", item);
    expect(verdict(ledger, item, { state: "ready" })).toEqual({ ok: true });
    recordW(ledger, "work.started", item);
    expect(verdict(ledger, item, { state: "in_progress" })).toEqual({ ok: true });
  });

  it("lets the approval and risk clauses win over the W clauses", () => {
    const { ledger, store } = fixture();
    const gated = createRecorded(ledger, store, makeNewItem({ risk: HIGH_RISK }));
    expect(verdict(ledger, gated, { state: "in_progress" })).toEqual({ ok: false, reason: "approval_unrecorded" });
    recordW(ledger, "work.started", gated);
    const downgraded = { ...gated.front.risk, class: "normal" as const };
    expect(verdict(ledger, gated, { state: "in_progress", risk: downgraded })).toEqual({ ok: false, reason: "risk_mismatch" });
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

  it("keeps an item with a W trail, and lists a hand-edited or lagging one as malformed with the ledger reason", () => {
    const { ledger, store } = fixture();
    const running = createRecorded(ledger, store, makeNewItem({ title: "Cache the render path" }));
    recordW(ledger, "work.started", running);
    rewriteItem(running, { state: "in_progress" });
    const forged = createRecorded(ledger, store, makeNewItem({ title: "Warm the cache" }));
    rewriteItem(forged, { state: "awaiting_review" });
    const lagging = createRecorded(ledger, store, makeNewItem({ title: "Trim the logs" }));
    recordW(ledger, "work.started", lagging); // the crash came before item.md was written

    const result = verifiedItems(store, ledger.readVerified(), "g-fast");
    expect(result.items.map((item) => item.front.work_id)).toEqual([running.front.work_id]);
    expect(Object.fromEntries(result.malformed.map((entry) => [entry.work_id, entry.reason]))).toEqual({
      [forged.front.work_id]: "w_event_missing",
      [lagging.front.work_id]: "w_repairable",
    });
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
