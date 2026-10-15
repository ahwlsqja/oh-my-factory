import { describe, expect, it } from "vitest";
import { noiseCheck, noiseReasonCode } from "../../src/feedback/noise.js";
import { FeedbackError } from "../../src/feedback/types.js";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof FeedbackError ? err.code : "not a FeedbackError";
  }
  return undefined;
}

describe("noiseCheck", () => {
  it("forces not_recommended when k cannot detect flakiness", () => {
    expect(noiseCheck({ k: 1, flaky_train: 0, flaky_test: null })).toEqual({
      status: "not_evaluated",
      k: 1,
      flaky_train: 0,
      flaky_test: null,
      force_not_recommended: true,
      reason: "k_below_2",
    });
    // k_below_2 wins over flaky_scenarios: with one repetition a "flaky" count is itself not trustworthy.
    expect(noiseCheck({ k: 1, flaky_train: 2, flaky_test: 1 }).reason).toBe("k_below_2");
  });

  it("forces on any flaky scenario in either split", () => {
    expect(noiseCheck({ k: 3, flaky_train: 1, flaky_test: null })).toMatchObject({
      force_not_recommended: true,
      reason: "flaky_scenarios",
    });
    expect(noiseCheck({ k: 3, flaky_train: 0, flaky_test: 2 })).toMatchObject({
      force_not_recommended: true,
      reason: "flaky_scenarios",
    });
  });

  it("does not force when k >= 2, nothing is flaky and the test split has not run", () => {
    expect(noiseCheck({ k: 2, flaky_train: 0, flaky_test: null })).toEqual({
      status: "not_evaluated",
      k: 2,
      flaky_train: 0,
      flaky_test: null,
      force_not_recommended: false,
      reason: "none",
    });
    expect(noiseCheck({ k: 3, flaky_train: 0, flaky_test: 0 }).force_not_recommended).toBe(false);
  });

  it("never claims a variance estimate", () => {
    for (const k of [1, 2, 3, 10]) {
      for (const flakyTrain of [0, 1]) {
        for (const flakyTest of [null, 0, 1]) {
          expect(noiseCheck({ k, flaky_train: flakyTrain, flaky_test: flakyTest }).status).toBe("not_evaluated");
        }
      }
    }
  });

  it("refuses impossible inputs", () => {
    expect(codeOf(() => noiseCheck({ k: 0, flaky_train: 0, flaky_test: null }))).toBe("invalid_input");
    expect(codeOf(() => noiseCheck({ k: 2.5, flaky_train: 0, flaky_test: null }))).toBe("invalid_input");
    expect(codeOf(() => noiseCheck({ k: 3, flaky_train: -1, flaky_test: null }))).toBe("invalid_input");
    expect(codeOf(() => noiseCheck({ k: 3, flaky_train: 0, flaky_test: 1.5 }))).toBe("invalid_input");
  });
});

describe("noiseReasonCode", () => {
  it("is noise_unverified only for k < 2 and flaky_scenario (M3b2's own code) for a flaky scenario, so one downgrade has one code", () => {
    expect(noiseReasonCode(noiseCheck({ k: 1, flaky_train: 0, flaky_test: null }))).toBe("noise_unverified");
    // k_below_2 wins over flaky counts, as in noiseCheck.
    expect(noiseReasonCode(noiseCheck({ k: 1, flaky_train: 2, flaky_test: 1 }))).toBe("noise_unverified");
    expect(noiseReasonCode(noiseCheck({ k: 3, flaky_train: 1, flaky_test: null }))).toBe("flaky_scenario");
    expect(noiseReasonCode(noiseCheck({ k: 3, flaky_train: 0, flaky_test: 2 }))).toBe("flaky_scenario");
  });

  it("is null when nothing is forced", () => {
    expect(noiseReasonCode(noiseCheck({ k: 3, flaky_train: 0, flaky_test: null }))).toBeNull();
    expect(noiseReasonCode(noiseCheck({ k: 2, flaky_train: 0, flaky_test: 0 }))).toBeNull();
  });
});
