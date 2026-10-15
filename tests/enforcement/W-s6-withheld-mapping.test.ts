import { describe, expect, it } from "vitest";
import { BudgetError } from "../../src/core/budget.js";
import { FeedbackError, type FeedbackErrorCode } from "../../src/feedback/types.js";
import type { StationResult } from "../../src/work/sequencer.js";
import { feedbackErrorResult, withheldResult } from "../../src/judge/s6-station.js";
import { setupLine } from "../helpers/line.js";
import { contextOf, declareDisclosure, judgeSpy, roundState, slot, stationOf, typesOf } from "../helpers/s6-fixture.js";

const blocked = (reason_code: string): StationResult => ({ kind: "blocked", reason_code }) as StationResult;
const MANUAL: StationResult = { kind: "manual", reason_code: "manual_required" };

// M3f-D13 with X-21. Every reason code below is a closed identifier; no message, id or count reaches the ledger or the handoff.
describe("W-s6-withheld-mapping", () => {
  it("maps every withheld reason", () => {
    expect(withheldResult("disclosure_exhausted")).toEqual(blocked("disclosure_unavailable"));
    expect(withheldResult("exposure_limit")).toEqual(blocked("scenarios_exhausted"));
    expect(withheldResult("too_few_scenarios")).toEqual(blocked("scenarios_exhausted"));
  });

  it.each([
    ["not_declared", blocked("disclosure_unavailable")],
    ["no_train_scenarios", blocked("scenarios_exhausted")],
    ["reseal_not_authorized", blocked("test_reseal_required")],
    ["test_already_consumed", blocked("test_run_incomplete")],
    ["invalid_input", MANUAL],
    ["invalid_event", MANUAL],
    ["no_open_test_run", MANUAL],
    ["nothing_to_reseal", MANUAL],
    ["already_authorized", MANUAL],
    ["forbidden", MANUAL],
  ] as [FeedbackErrorCode, StationResult][])("maps the feedback error %s", (code, expected) => {
    expect(feedbackErrorResult(new FeedbackError(code, "fixed text"))).toEqual(expected);
  });

  it("stops at J8 when no disclosure budget is declared, and releases nothing", async () => {
    const l = setupLine();
    const feedback = slot();
    const state = roundState(["fail", "pass", "pass", "pass", "pass", "pass"]);

    const result = await stationOf(l, state, judgeSpy(l).judge, feedback).run(contextOf(l));

    expect(result).toEqual(blocked("disclosure_unavailable"));
    expect(feedback.puts).toEqual([]);
    expect(typesOf(l)).not.toContain("feedback.released");
  });

  it("stops at J8 when the last unit is spent and a better score would need another", async () => {
    const l = setupLine();
    declareDisclosure(l, 1);
    const feedback = slot();
    const worse = roundState(["fail", "fail", "fail", "fail", "fail", "fail"]);
    // a gain of 3 on n=6 clears the release margin (10d >= n and d*d >= n); a gain of 1 would only repeat the best
    const better = roundState(["pass", "pass", "pass", "fail", "fail", "fail"]);

    expect(await stationOf(l, worse, judgeSpy(l).judge, feedback).run(contextOf(l))).toMatchObject({ kind: "rework" });
    expect(await stationOf(l, better, judgeSpy(l).judge, feedback).run(contextOf(l))).toEqual(
      blocked("disclosure_unavailable"),
    );
    expect(feedback.puts).toHaveLength(1);
  });

  it("does not map a budget integrity error: it propagates and the sequencer records a station error", async () => {
    const l = setupLine();
    declareDisclosure(l, 40);
    l.fx.ledger.append({
      actor: "omf",
      type: "budget.consumed",
      payload: { goal_id: l.fx.goalId, kind: "tokens", amount: 1 },
    });
    const state = roundState(["fail", "pass", "pass", "pass", "pass", "pass"]);

    await expect(stationOf(l, state, judgeSpy(l).judge, slot()).run(contextOf(l))).rejects.toBeInstanceOf(BudgetError);
  });
});
