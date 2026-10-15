import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/core/ledger.js";
import { RECENT_OUTCOME_WINDOW, recentOutcomes } from "../../src/work/recent-outcomes.js";
import { makeTempDir } from "../helpers/tmp.js";
import { FIXTURE_RUN_ID, recordW } from "../helpers/work.js";

const GOAL = "g-fast";
const newLedger = (): Ledger => new Ledger(makeTempDir("omf-recent-"));
/** The part of a work item that recordW needs. Ids are distinct and match the work-id pattern. */
const item = (n: number, goalId: string = GOAL) => ({
  front: { goal_id: goalId, work_id: `w-${n.toString(16).padStart(12, "0")}` },
});
const idsOf = (...items: ReturnType<typeof item>[]): Set<string> => new Set(items.map((entry) => entry.front.work_id));
const payloadOf = (entry: ReturnType<typeof item>): Record<string, unknown> => ({
  ...entry.front,
  run_id: FIXTURE_RUN_ID,
});

describe("recentOutcomes", () => {
  it("counts each item once, by the outcome of its last state-bearing event", () => {
    const ledger = newLedger();
    const a = item(1);
    const b = item(2);
    const c = item(3);
    const d = item(4);
    const e = item(5);
    const f = item(6);
    for (const started of [a, b, c, d]) recordW(ledger, "work.started", started);
    recordW(ledger, "work.submitted", a);
    recordW(ledger, "work.submitted", b, { outcome: "flawed", recommendation: "not_recommended" });
    recordW(ledger, "work.failed", c, { outcome: "flawed", reason_code: "station_error" });
    recordW(ledger, "work.failed", d);
    recordW(ledger, "work.parked", e);
    recordW(ledger, "work.parked", f, { outcome: "manual", reason_code: "manual_required" });
    expect(recentOutcomes(ledger.readVerified(), GOAL, idsOf(a, b, c, d, e, f))).toEqual({
      success: 1,
      flawed: 2,
      blocked: 2,
      manual: 1,
    });
  });

  it("does not count an item that is running again", () => {
    const ledger = newLedger();
    const parkedThenStarted = item(1);
    const resumed = item(2);
    const reclaimed = item(3);
    const parkedStill = item(4);
    const finishedAfterResume = item(5);
    // Parked while still ready, then a run started it.
    recordW(ledger, "work.parked", parkedThenStarted);
    recordW(ledger, "work.started", parkedThenStarted);
    // Parked after start, then a new run took over (work.started is legal only from ready, so it is work.resumed).
    recordW(ledger, "work.started", resumed);
    recordW(ledger, "work.parked", resumed);
    recordW(ledger, "work.resumed", resumed);
    // Parked after start, then a killed run's claim was reclaimed.
    recordW(ledger, "work.started", reclaimed);
    recordW(ledger, "work.parked", reclaimed);
    recordW(ledger, "work.claim_reclaimed", reclaimed);
    // Control: parked and left alone, so it counts.
    recordW(ledger, "work.started", parkedStill);
    recordW(ledger, "work.parked", parkedStill, { outcome: "manual", reason_code: "manual_required" });
    // Control: running again and then finished counts by the new end.
    recordW(ledger, "work.started", finishedAfterResume);
    recordW(ledger, "work.parked", finishedAfterResume);
    recordW(ledger, "work.resumed", finishedAfterResume);
    recordW(ledger, "work.submitted", finishedAfterResume);
    const events = ledger.readVerified();
    const all = idsOf(parkedThenStarted, resumed, reclaimed, parkedStill, finishedAfterResume);
    expect(recentOutcomes(events, GOAL, all)).toEqual({ success: 1, flawed: 0, blocked: 0, manual: 1 });
  });

  it("ignores forged and invalid events, other goals and ids that are not listed", () => {
    const ledger = newLedger();
    const kept = item(1);
    const forged = item(2);
    const invalid = item(3);
    const foreign = item(4, "g-other");
    const unlisted = item(5);
    // A valid park, then a forged start: the forgery neither counts nor takes the item out of the count.
    recordW(ledger, "work.parked", kept);
    ledger.append({ actor: "agent:x", type: "work.started", payload: { ...payloadOf(kept), from: "ready" } });
    ledger.append({
      actor: "human:dev",
      type: "work.submitted",
      payload: { ...payloadOf(forged), outcome: "success", recommendation: "merge_recommended" },
    });
    ledger.append({
      actor: "omf",
      type: "work.failed",
      payload: { ...payloadOf(invalid), outcome: "flawed", reason_code: "not_a_code" },
    });
    recordW(ledger, "work.submitted", foreign);
    recordW(ledger, "work.submitted", unlisted);
    // The foreign item is listed on purpose: the goal filter must hold on its own.
    const listed = idsOf(kept, forged, invalid, foreign);
    expect(recentOutcomes(ledger.readVerified(), GOAL, listed)).toEqual({
      success: 0,
      flawed: 0,
      blocked: 1,
      manual: 0,
    });
  });

  it("keeps the newest items by the seq of their last event, not by when they started", () => {
    const ledger = newLedger();
    const all = Array.from({ length: 12 }, (_, n) => item(n + 1));
    for (const started of all) recordW(ledger, "work.started", started);
    for (const done of all.slice(2)) recordW(ledger, "work.submitted", done);
    // The two oldest items end last, so they are the newest outcomes.
    for (const late of all.slice(0, 2)) recordW(ledger, "work.failed", late);
    const events = ledger.readVerified();
    const listed = idsOf(...all);
    expect(RECENT_OUTCOME_WINDOW).toBe(10);
    expect(recentOutcomes(events, GOAL, listed)).toEqual({ success: 8, flawed: 0, blocked: 2, manual: 0 });
    expect(recentOutcomes(events, GOAL, listed, 3)).toEqual({ success: 1, flawed: 0, blocked: 2, manual: 0 });
    expect(recentOutcomes(events, GOAL, listed, 12)).toEqual({ success: 10, flawed: 0, blocked: 2, manual: 0 });
    expect(() => recentOutcomes(events, GOAL, listed, 0)).toThrow(RangeError);
  });

  it("is four zeros for an empty ledger and has exactly the four integer keys", () => {
    const counts = recentOutcomes([], GOAL, new Set());
    expect(counts).toEqual({ success: 0, flawed: 0, blocked: 0, manual: 0 });
    expect(Object.keys(counts).sort()).toEqual(["blocked", "flawed", "manual", "success"]);
  });
});
