import { describe, expect, it } from "vitest";
import { foldDecisions } from "../../src/decision/state.js";
import type { ImplementerFeedback } from "../../src/feedback/release.js";
import { parseScenarioResults, trainCounts } from "../../src/feedback/tally.js";
import { harnessSetOf, toScenarioResults } from "../../src/judge/results.js";
import type { ScenarioTally } from "../../src/judge/round.js";
import { createFeedbackSlot } from "../../src/judge/round-state.js";
import { scenarioRef } from "../../src/scenario/types.js";
import { seedSealedItem } from "../helpers/scenario-fixture.js";

function tally(ref: string, kind: ScenarioTally["kind"], outcomes: ScenarioTally["outcomes"]): ScenarioTally {
  const passes = outcomes.filter((outcome) => outcome === "pass").length;
  const verdict = outcomes.includes("error")
    ? "error"
    : passes === outcomes.length
      ? "pass"
      : passes === 0
        ? "fail"
        : "flaky";
  return { scenario_ref: ref, category: "interface", kind, outcomes, verdict };
}

describe("harnessSetOf", () => {
  it("keeps the steps, drops everything the SUT side could learn from, and categorizes by linked decision (E2)", () => {
    const sealed = seedSealedItem();
    const state = foldDecisions(sealed.f.fx.ledger.readVerified(), sealed.f.scope);
    const set = harnessSetOf(sealed.scenarios, state);
    const text = JSON.stringify(set);
    expect(text).toContain("key-1"); // positive control: the argv is there
    for (const scenario of sealed.scenarios) {
      expect(text).not.toContain(scenario.scenario_id);
      expect(text).not.toContain(scenario.canary);
    }
    for (const hidden of ["scenario 1", "d-interface", "author"]) expect(text).not.toContain(hidden);
    expect(set.map((entry) => entry.scenario_ref)).toEqual(sealed.scenarios.map((s) => scenarioRef(s.scenario_id)));
    expect(set.map((entry) => [entry.split, entry.kind, entry.category])).toEqual([
      ["train", "behavior", "interface"],
      ["test", "behavior", "compatibility"],
      ["train", "contradiction_canary", "other"],
    ]);
  });
});

describe("toScenarioResults", () => {
  it("maps behavior tallies to the closed result, leaves canaries out and refuses an error verdict", () => {
    const results = toScenarioResults([
      tally("a".repeat(16), "behavior", ["pass", "pass", "pass"]),
      tally("b".repeat(16), "behavior", ["pass", "fail", "pass"]),
      tally("c".repeat(16), "behavior", ["fail", "fail", "fail"]),
      tally("d".repeat(16), "contradiction_canary", ["fail", "fail", "fail"]),
    ]);
    expect(results).toEqual([
      { category: "interface", passed: true, flaky: false },
      { category: "interface", passed: false, flaky: true },
      { category: "interface", passed: false, flaky: false },
    ]);
    expect(parseScenarioResults(results)).toEqual(results);
    expect(trainCounts(results)).toEqual({ pass: 1, total: 3, flaky: 1 });
    expect(() => toScenarioResults([tally("e".repeat(16), "behavior", ["pass", "error"])])).toThrow(
      "an error verdict never reaches the mapper",
    );
  });
});

describe("FeedbackSlot", () => {
  it("hands each feedback over once and remembers every text it was given", () => {
    const slot = createFeedbackSlot();
    const first = { text: "first" } as ImplementerFeedback;
    slot.put(first, "first");
    expect(slot.take()).toBe(first);
    expect(slot.take()).toBeNull();
    slot.put({ text: "second" } as ImplementerFeedback, "second");
    expect(slot.released()).toEqual(["first", "second"]);
  });
});
