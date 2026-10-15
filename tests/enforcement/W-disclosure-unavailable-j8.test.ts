import { describe, expect, it } from "vitest";
import { parseBudgetArgs } from "../../src/cli/work.js";
import { validate } from "../../src/core/schema.js";
import { HANDOFF_ROUTES, buildHandoff } from "../../src/work/handoff.js";
import { dispositionOf } from "../../src/work/outcome.js";

// Feedback needs a per-goal disclosure budget that a person declared (spec §6.3, J8). Without one, or with it used up, the
// item parks `disclosure_unavailable` and the hand-off names the two real commands with the real goal id.
const GOAL = "g-checkout";
const record = buildHandoff({
  kind: "outcome",
  scope: { work_id: "w-0123456789ab", goal_id: GOAL, run_id: "r-20261014T091500Z-ab12" },
  predecessor_seq: null,
  classification: { outcome: "blocked", reason_code: "disclosure_unavailable", unverified_areas: [] },
  ran: [{ node: "S2", result: "handed_off" }],
  remaining: ["GATE-2", "S3"],
  now: new Date("2026-10-14T09:15:00.000Z"),
});

describe("W-disclosure-unavailable-j8", () => {
  it("is a J8 hand-off naming the declare and raise commands for the goal, and the item parks", () => {
    expect(validate("handoff.schema.json", record)).toEqual({ ok: true });
    expect(record.decision_required.j).toBe("J8");
    expect(record.decision_required.options).toContain(`omf budget declare ${GOAL} disclosure <n>`);
    expect(record.decision_required.options).toContain(`omf budget raise ${GOAL} disclosure <n>`);
    expect(HANDOFF_ROUTES.disclosure_unavailable.j).toBe("J8");
    expect(dispositionOf({ outcome: "blocked", exhausted: false, reason_code: "disclosure_unavailable" })).toEqual({
      action: "park",
      item_state: "unchanged",
      counts_toward_stop_if: false,
    });
  });

  it("names commands the budget parser accepts once <n> is a number", () => {
    const named = record.decision_required.options.flatMap((option) => {
      const match = /^omf budget (declare|raise) (g-\S+) disclosure <n>$/.exec(option);
      if (match === null) return [];
      return [{ verb: match[1] === "declare" ? ("declare" as const) : ("raise" as const), goalId: match[2] ?? "" }];
    });
    expect(named).toHaveLength(2);
    for (const { verb, goalId } of named) {
      const parsed = parseBudgetArgs({ verb, goalId, kind: "disclosure", amount: "3" });
      expect(parsed).toMatchObject({ verb, goalId: GOAL, kind: "disclosure", amount: 3 });
    }
  });
});
