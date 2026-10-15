import { describe, expect, it } from "vitest";
import { gate3Gate } from "../../src/gate/gate3-gate.js";
import { evaluateGate2 } from "../../src/scenario/gate2.js";
import { baselineScenarios, effective, passingInput, rebuild } from "../helpers/gate2-input.js";
import { arrangeHealthy, setupGate3 } from "../helpers/gate3-line.js";

// The judge must be seen to reject a contradiction canary, so a set needs one in either split before S4 can use it (GATE-2
// `canary_missing`). A canary that lives only in the test split is judged by S4 too, so GATE-3 is never vacuous.
const withoutCanary = () => baselineScenarios().filter((entry) => entry.scenario.kind !== "contradiction_canary");

describe("W-canary-required-before-s4", () => {
  it("a set with no contradiction canary in either split fails GATE-2 canary_missing and goes back to S2", () => {
    const result = evaluateGate2(rebuild(passingInput(), withoutCanary()));
    if (result.status !== "fail") throw new Error("expected GATE-2 to fail");
    expect(result.reasons.map((reason) => reason.code)).toContain("canary_missing");
    expect(result.route).toBe("back_to_S2");
  });

  it("a canary only in the test split satisfies the rule", () => {
    const scenarios = [...withoutCanary(), effective({ kind: "contradiction_canary", split: "test" })];
    expect(evaluateGate2(rebuild(passingInput(), scenarios)).status).toBe("pass");
  });

  it("GATE-3 accepts a round whose judge ran the canary and reads a round without one as not run", async () => {
    const judged = setupGate3();
    arrangeHealthy(judged);
    expect((await gate3Gate().evaluate(judged.ctx())).verdict).toBe("pass");
    const none = setupGate3();
    arrangeHealthy(none, { judge: { contradiction_scenarios: 0, contradiction_rejected: 0 } });
    expect((await gate3Gate().evaluate(none.ctx())).reasons).toEqual(["contradiction_canary_not_run"]);
  });
});
