import { describe, expect, it } from "vitest";
import { s4Rig } from "../helpers/judge-rig.js";
import { CANARY_SPEC, STRONG_EXPECT, type SeedSpec } from "../helpers/scenario-fixture.js";

const BEHAVIOR_TRAIN: SeedSpec = { split: "train", refs: ["d-interface"], expect: STRONG_EXPECT };
const BEHAVIOR_TEST: SeedSpec = { split: "test", refs: ["d-cache"], expect: STRONG_EXPECT };
const TEST_CANARY: SeedSpec = { ...CANARY_SPEC, split: "test" };

// M3f-D20: GATE-2 accepts a contradiction canary in either split, so S4 judges the canaries of BOTH splits (the harness is
// OMF code and the SUT never sees an expectation) and never a test-split behavior scenario. A canary that lives only in
// the test split is therefore judged before GATE-3 without spending the test split's single use.
describe("W-canary-both-splits", () => {
  it("judges a canary that lives only in the test split and no test-split behavior scenario", async () => {
    const r = s4Rig({ specs: [BEHAVIOR_TRAIN, BEHAVIOR_TEST, TEST_CANARY] });
    expect((await r.station.run(r.ctx())).kind).toBe("ok");
    const round = r.engine.rounds[0];
    expect(round?.phase).toBe("train");
    expect(round?.scenarios.map((scenario) => [scenario.split, scenario.kind])).toEqual([
      ["train", "behavior"],
      ["test", "contradiction_canary"],
    ]);
    const event = r.s.f.fx.ledger.readVerified().find((e) => e.type === "judge.round_completed");
    expect(event?.payload).toMatchObject({ contradiction_scenarios: 1, contradiction_rejected: 1 });
  });

  it("judges the canaries of both splits together", async () => {
    const r = s4Rig({ specs: [BEHAVIOR_TRAIN, BEHAVIOR_TEST, CANARY_SPEC, TEST_CANARY] });
    expect((await r.station.run(r.ctx())).kind).toBe("ok");
    const judged = r.engine.rounds[0]?.scenarios ?? [];
    expect(judged.filter((s) => s.kind === "contradiction_canary").map((s) => s.split)).toEqual(["train", "test"]);
    expect(judged.some((s) => s.split === "test" && s.kind === "behavior")).toBe(false);
    const event = r.s.f.fx.ledger.readVerified().find((e) => e.type === "judge.round_completed");
    expect(event?.payload).toMatchObject({ contradiction_scenarios: 2 });
  });
});
