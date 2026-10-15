import { describe, expect, it } from "vitest";
import {
  categoryOf,
  mergeSmallCategories,
  parseScenarioResults,
  tallyResults,
  trainCounts,
} from "../../src/feedback/tally.js";
import { FeedbackError, MIN_CATEGORY_SIZE } from "../../src/feedback/types.js";
import type { CategoryTally } from "../../src/feedback/types.js";
import { DECISION_CLASSES, isQuantitative } from "../../src/decision/types.js";
import { scenarios } from "../helpers/feedback.js";

/** Strings a caller might smuggle in. None of them, and none of the extra key names, may come back in a message. */
const PLANTED = ["s-canary-7731", "canary input text", "expected output text", "zz_canary_class"];
const PLANTED_KEYS = ["scenario_id", "input", "expected", "canary"];

function refusal(value: unknown): FeedbackError {
  try {
    parseScenarioResults(value);
  } catch (err) {
    if (err instanceof FeedbackError) return err;
    throw err;
  }
  throw new Error("expected parseScenarioResults to refuse");
}

const tally = (category: CategoryTally["category"], pass: number, total: number, flaky = 0): CategoryTally => ({
  category,
  pass,
  total,
  flaky,
});

describe("parseScenarioResults", () => {
  it("accepts exactly category, passed and flaky", () => {
    const input = [
      { category: "security", passed: true, flaky: false },
      { category: "interface", passed: false, flaky: true },
    ];
    expect(parseScenarioResults(input)).toEqual(input);
    expect(parseScenarioResults([])).toEqual([]);
  });

  it.each([
    ["a non-array", { category: "security", passed: true, flaky: false }, "must be an array"],
    ["a non-object item", ["security"], "not_an_object"],
    ["a null item", [null], "not_an_object"],
    ["a missing key", [{ category: "security", passed: true }], "missing_key"],
    ["a non-boolean passed", [{ category: "security", passed: "yes", flaky: false }], "not_boolean"],
    ["a non-boolean flaky", [{ category: "security", passed: true, flaky: 0 }], "not_boolean"],
    ["an unknown class", [{ category: PLANTED[3], passed: true, flaky: false }], "unknown_category"],
    ["a non-string class", [{ category: 7, passed: true, flaky: false }], "unknown_category"],
    ["a quantitative class", [{ category: "latency", passed: true, flaky: false }], "quantitative_category"],
    ["passed and flaky", [{ category: "security", passed: true, flaky: true }], "flaky_and_passed"],
  ])("refuses %s with invalid_input", (_label, input, reason) => {
    const err = refusal(input);
    expect(err.code).toBe("invalid_input");
    expect(err.message).toContain(reason);
  });

  it.each(PLANTED_KEYS.map((key, i) => [key, PLANTED[i]] as const))("refuses the extra key %s without echoing it", (key, value) => {
    const err = refusal([
      { category: "security", passed: true, flaky: false },
      { category: "security", passed: true, flaky: false, [key]: value },
    ]);
    expect(err.code).toBe("invalid_input");
    expect(err.message).toContain("scenario result 1");
    expect(err.message).toContain("extra_key");
    for (const secret of [...PLANTED, ...PLANTED_KEYS]) expect(err.message).not.toContain(secret);
  });

  it("does not echo a planted class name either", () => {
    const err = refusal([{ category: PLANTED[3], passed: true, flaky: false }]);
    for (const secret of PLANTED) expect(err.message).not.toContain(secret);
  });
});

describe("categoryOf", () => {
  it("prefers a non-interface class, in DECISION_CLASSES order", () => {
    expect(categoryOf(["interface", "security"])).toBe("security");
    expect(categoryOf(["security", "compatibility"])).toBe("compatibility");
    expect(categoryOf(["other", "interface"])).toBe("other");
  });

  it("falls back to interface, then to other", () => {
    expect(categoryOf(["interface"])).toBe("interface");
    expect(categoryOf(["latency", "interface"])).toBe("interface");
    expect(categoryOf([])).toBe("other");
    expect(categoryOf(["latency", "memory"])).toBe("other");
  });

  it("never returns a quantitative class, for any pair of linked classes", () => {
    for (const a of DECISION_CLASSES) {
      expect(isQuantitative(categoryOf([a]))).toBe(false);
      for (const b of DECISION_CLASSES) expect(isQuantitative(categoryOf([a, b]))).toBe(false);
    }
  });
});

describe("tallyResults", () => {
  it("counts per class in DECISION_CLASSES order, whatever the input order", () => {
    const results = [...scenarios("security", 2, 1), ...scenarios("interface", 1, 0)];
    expect(tallyResults(results)).toEqual([
      { category: "interface", pass: 1, total: 1, flaky: 0 },
      { category: "security", pass: 2, total: 3, flaky: 0 },
    ]);
  });

  it("counts a flaky scenario as not passed and as flaky", () => {
    expect(tallyResults(scenarios("interface", 2, 1, 2))).toEqual([{ category: "interface", pass: 2, total: 5, flaky: 2 }]);
  });

  it("returns nothing for no results", () => {
    expect(tallyResults([])).toEqual([]);
  });
});

describe("mergeSmallCategories", () => {
  it("adds categories of 4 and 3 into the largest and keeps its name", () => {
    const merged = mergeSmallCategories([tally("compatibility", 5, 7, 1), tally("security", 2, 4), tally("other", 1, 3, 1)]);
    expect(merged).toEqual([{ category: "compatibility", pass: 8, total: 14, flaky: 2 }]);
  });

  it("keeps a category of exactly 5 and merges only the small ones", () => {
    const merged = mergeSmallCategories([tally("interface", 6, 7), tally("compatibility", 3, 5), tally("data_model", 1, 4)]);
    expect(merged).toEqual([tally("interface", 7, 11), tally("compatibility", 3, 5)]);
    expect(MIN_CATEGORY_SIZE).toBe(5);
  });

  it("breaks a tie for the largest toward the earlier class, whatever the input order", () => {
    const merged = mergeSmallCategories([tally("other", 0, 2), tally("security", 3, 6), tally("compatibility", 3, 6)]);
    expect(merged).toEqual([tally("compatibility", 3, 8), tally("security", 3, 6)]);
  });

  it("collapses everything into the largest when all are below 5", () => {
    const merged = mergeSmallCategories([tally("other", 1, 1), tally("security", 1, 2), tally("compatibility", 2, 3)]);
    expect(merged).toEqual([tally("compatibility", 4, 6)]);
  });

  it("returns nothing for nothing, and does not change its input", () => {
    expect(mergeSmallCategories([])).toEqual([]);
    const input = [tally("compatibility", 5, 7), tally("security", 2, 4)];
    mergeSmallCategories(input);
    expect(input).toEqual([tally("compatibility", 5, 7), tally("security", 2, 4)]);
  });

  it("honours a smaller min", () => {
    expect(mergeSmallCategories([tally("interface", 3, 3), tally("security", 1, 2)], 2)).toEqual([
      tally("interface", 3, 3),
      tally("security", 1, 2),
    ]);
  });
});

describe("trainCounts", () => {
  it("counts passed, total and flaky for the evidence field", () => {
    expect(trainCounts([...scenarios("interface", 2, 1, 1), ...scenarios("security", 1, 0)])).toEqual({ pass: 3, total: 5, flaky: 1 });
    expect(trainCounts([])).toEqual({ pass: 0, total: 0, flaky: 0 });
  });
});
