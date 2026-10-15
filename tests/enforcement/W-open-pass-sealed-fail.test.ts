import { describe, expect, it } from "vitest";
import { setupLine } from "../helpers/line.js";
import {
  classifyLine,
  cleanInputs,
  contextOf,
  judgeSpy,
  roundState,
  slot,
  stationOf,
  typesOf,
} from "../helpers/s6-fixture.js";

// "Open pass, sealed fail" (spec §5.5): the implementer's own tests pass and the train split is clean, but the sealed
// test split fails. This is the case the whole sealing design exists for, and it must read `flawed`, never success.
describe("W-open-pass-sealed-fail", () => {
  it("reads flawed sealed_failed, not recommended, when only the test split fails", async () => {
    const l = setupLine();
    const inputs = cleanInputs(); // prove-test passed, no test edited, no canary, GREEN gate line, train 6/6
    const spy = judgeSpy(l, ["pass", "fail", "fail", "pass"]);

    const result = await stationOf(l, roundState(), spy.judge, slot()).run(contextOf(l, inputs));

    expect(result).toMatchObject({ kind: "ok" });
    expect(inputs.sealed.test).toEqual({ pass: 2, total: 4 });
    expect(classifyLine(inputs)).toMatchObject({
      outcome: "flawed",
      reason_code: "sealed_failed",
      rule: "sealed_failed",
      recommendation: "not_recommended",
    });
  });

  it("reads a flaky test scenario as sealed_failed, not flaky_scenario, and still records the flakiness (M3f-D14)", async () => {
    const l = setupLine();
    const inputs = cleanInputs();
    const spy = judgeSpy(l, ["pass", "pass", "pass", "flaky"]);

    await stationOf(l, roundState(), spy.judge, slot()).run(contextOf(l, inputs));

    expect(inputs.sealed.test).toEqual({ pass: 3, total: 4 });
    expect(classifyLine(inputs)).toMatchObject({ outcome: "flawed", reason_code: "sealed_failed" });
    const completed = l.events().find((event) => event.type === "feedback.test_run_completed");
    expect(completed?.payload).toMatchObject({ pass: 3, total: 4, flaky: 1 });
    expect(typesOf(l)).toContain("judge.round_completed");
  });
});
