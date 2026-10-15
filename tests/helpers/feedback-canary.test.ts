import { describe, expect, it } from "vitest";
import {
  FAKE_DECISION_CLASS,
  FB_CANARY,
  FB_CANARY_LABELS,
  containsToken,
  digestOf,
  fbCanaryHits,
  makeSet,
  mulberry32,
  plantedOf,
  plantedScenario,
  toResults,
  verdictsFor,
} from "./feedback-canary.js";

describe("fbCanaryHits", () => {
  it("finds each planted value", () => {
    expect(fbCanaryHits(`the guid ${FB_CANARY.guid}`)).toEqual(["guid"]);
    expect(fbCanaryHits(`id ${FB_CANARY.scenarioId}`)).toEqual(["scenario id", "scenario id shape"]);
    expect(fbCanaryHits(`got ${FB_CANARY.decimal} back`)).toEqual(["decimal", "decimal digits"]);
    expect(fbCanaryHits(`after ${FB_CANARY.longInteger} ms`)).toEqual(["long integer"]);
    expect(fbCanaryHits("HELIOTROPE and marmoset")).toEqual(["word heliotrope", "word marmoset"]);
  });

  it("does not report a canary glued into a longer token, and finds nothing in a feedback text", () => {
    expect(fbCanaryHits("hash a7731b0c906482d and w-7731abcdef01")).toEqual([]);
    expect(
      fbCanaryHits(
        "Masked feedback from the train scenarios.\n- interface: 33% of 6 scenarios\nNo other information about the scenarios is available.",
      ),
    ).toEqual([]);
  });

  it("lists its labels in the order it reports them", () => {
    expect(FB_CANARY_LABELS).toEqual([
      "guid",
      "scenario id",
      "scenario id shape",
      "decimal",
      "decimal digits",
      "long integer",
      "word heliotrope",
      "word marmoset",
    ]);
    expect(containsToken("x 1234.5678 y", "1234.5678")).toBe(true);
    expect(containsToken("deadbeef1234cafe", "1234")).toBe(false);
  });
});

describe("the fake vault and the test-local mapper", () => {
  it("makes a set whose first scenario carries every fixed canary and is reproducible from its seed", () => {
    const layout = [{ refs: ["d-interface"], count: 3 }];
    const first = makeSet(mulberry32(5), layout);
    const again = makeSet(mulberry32(5), layout);
    expect(again).toEqual(first);
    expect(fbCanaryHits(JSON.stringify(first[0]))).toEqual(FB_CANARY_LABELS);
    expect(new Set(first.map((s) => s.scenario_id)).size).toBe(3);
    expect(plantedOf(plantedScenario(mulberry32(5), 0, ["d-interface"]))).toEqual([
      FB_CANARY.scenarioId,
      FB_CANARY.guid,
      ...FB_CANARY.words,
      FB_CANARY.decimal,
      FB_CANARY.longInteger,
    ]);
    expect(digestOf(first.map((s) => s.scenario_id))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("maps a scenario and its verdict to a result with three keys and no id", () => {
    const set = makeSet(mulberry32(9), [
      { refs: ["d-interface"], count: 1 },
      { refs: ["d-interface", "d-errors"], count: 1 },
      { refs: ["d-misc"], count: 1 },
    ]);
    const results = toResults(set, verdictsFor(set, new Set([0]), new Set([2])));
    expect(results).toEqual([
      { category: "interface", passed: true, flaky: false },
      { category: "error_semantics", passed: false, flaky: false },
      { category: "other", passed: false, flaky: true },
    ]);
    expect(fbCanaryHits(JSON.stringify(results))).toEqual([]);
    expect([...FAKE_DECISION_CLASS.values()]).toContain("data_model");
  });
});
