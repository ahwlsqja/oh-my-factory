import { describe, expect, it } from "vitest";
import {
  type Disposition,
  OUTCOME_ROWS,
  OutcomeError,
  type OutcomeInput,
  W_OUTCOMES,
  type WOutcome,
  dispositionOf,
} from "../../src/work/outcome.js";
import type { ReasonCode } from "../../src/work/w-events.js";

const input = (outcome: WOutcome, exhausted: boolean, extra: Partial<OutcomeInput> = {}): OutcomeInput => ({
  outcome,
  exhausted,
  reason_code: outcome === "success" ? null : "station_error",
  ...extra,
});

const submit = (recommendation: "merge_recommended" | "not_recommended" | "human_needed"): Disposition => ({
  action: "submit",
  item_state: "awaiting_review",
  recommendation,
  counts_toward_stop_if: true,
});
const fail: Disposition = { action: "fail", item_state: "failed", counts_toward_stop_if: false };
const park: Disposition = { action: "park", item_state: "unchanged", counts_toward_stop_if: false };

describe("outcome-to-state table (M3-D19)", () => {
  it("is exactly the six rows", () => {
    expect(OUTCOME_ROWS).toEqual([
      { outcome: "success", exhausted: false, disposition: submit("merge_recommended") },
      { outcome: "flawed", exhausted: false, disposition: submit("not_recommended") },
      { outcome: "flawed", exhausted: true, disposition: fail },
      { outcome: "blocked", exhausted: true, disposition: fail },
      { outcome: "blocked", exhausted: false, disposition: park },
      { outcome: "manual", exhausted: false, disposition: park },
    ]);
  });

  it("answers every outcome and exhaustion flag: six dispositions, two errors", () => {
    let errors = 0;
    for (const outcome of W_OUTCOMES) {
      for (const exhausted of [false, true]) {
        const row = OUTCOME_ROWS.find((r) => r.outcome === outcome && r.exhausted === exhausted);
        if (row === undefined) {
          expect(() => dispositionOf(input(outcome, exhausted)), `${outcome}/${exhausted}`).toThrow(OutcomeError);
          errors++;
        } else {
          expect(dispositionOf(input(outcome, exhausted)), `${outcome}/${exhausted}`).toEqual(row.disposition);
        }
      }
    }
    expect(errors).toBe(2);
    expect(() => dispositionOf(input("success", true))).toThrow(/no outcome row for success with exhausted=true/);
    expect(() => dispositionOf(input("manual", true))).toThrow(/no outcome row for manual with exhausted=true/);
  });

  it("accepts human_needed only on success, where it replaces the recommendation", () => {
    expect(dispositionOf(input("success", false, { human_needed: true }))).toEqual(submit("human_needed"));
    expect(dispositionOf(input("success", false, { human_needed: false }))).toEqual(submit("merge_recommended"));
    for (const outcome of ["flawed", "blocked", "manual"] as const) {
      expect(() => dispositionOf(input(outcome, false, { human_needed: true }))).toThrow(/human_needed is valid only on success/);
    }
  });

  it("wants no reason_code for success and a closed one for every other outcome", () => {
    expect(() => dispositionOf(input("success", false, { reason_code: "station_error" }))).toThrow(/a success carries no reason_code/);
    for (const outcome of ["flawed", "blocked", "manual"] as const) {
      expect(() => dispositionOf(input(outcome, false, { reason_code: null })), outcome).toThrow(/needs a reason_code from the closed list/);
      const loose = "p95_over_40ms" as unknown as ReasonCode;
      expect(() => dispositionOf(input(outcome, false, { reason_code: loose })), outcome).toThrow(OutcomeError);
    }
  });

  it("never reaches done, and only a submit counts toward STOP_IF", () => {
    for (const row of OUTCOME_ROWS) {
      expect(row.disposition.item_state).not.toBe("done");
      expect(row.disposition.counts_toward_stop_if).toBe(row.disposition.action === "submit");
    }
  });

  it("hands out a copy, so a caller cannot edit the table", () => {
    const first = dispositionOf(input("flawed", false));
    (first as { recommendation: string }).recommendation = "merge_recommended";
    expect(dispositionOf(input("flawed", false))).toEqual(submit("not_recommended"));
  });
});

describe("M3d reason codes", () => {
  it("parks a blocked outcome for the three codes only a person can clear, and submits a forced noise downgrade as not_recommended", () => {
    for (const reason_code of ["test_run_incomplete", "test_reseal_required", "scenarios_exhausted"] as const) {
      expect(dispositionOf({ outcome: "blocked", exhausted: false, reason_code }), reason_code).toEqual({
        action: "park",
        item_state: "unchanged",
        counts_toward_stop_if: false,
      });
    }
    expect(dispositionOf({ outcome: "flawed", exhausted: false, reason_code: "noise_unverified" })).toEqual({
      action: "submit",
      item_state: "awaiting_review",
      recommendation: "not_recommended",
      counts_toward_stop_if: true,
    });
  });
});
