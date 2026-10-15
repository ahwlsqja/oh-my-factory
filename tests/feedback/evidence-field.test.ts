import { describe, expect, it } from "vitest";
import { evidenceSealedTest, noiseCheckField, type SealedTestField } from "../../src/feedback/test-run.js";

// M3b2's evidence takes `sealed.test` as { pass, total } or "not run" and nothing else. M3d's SealedTestField
// has two more words ("consumed_incomplete", "consumed_other_candidate") and a flaky count. Those are for the
// host and the handoff; the evidence must never read a consumed-but-unusable run as a result, and a total of 0
// is never a pass (E7).
describe("evidenceSealedTest", () => {
  it("passes a recorded result through with exactly pass and total", () => {
    const field: SealedTestField = { pass: 3, total: 4, flaky: 1 };
    const value = evidenceSealedTest(field);
    expect(value).toEqual({ pass: 3, total: 4 });
    expect(Object.keys(value as object).sort()).toEqual(["pass", "total"]);
  });

  it.each(["not yet run", "consumed_incomplete", "consumed_other_candidate"] as const)(
    "reads %s as not run",
    (field) => {
      expect(evidenceSealedTest(field)).toBe("not run");
    },
  );

  it("reads a total of 0 as not run, never as a pass", () => {
    expect(evidenceSealedTest({ pass: 0, total: 0, flaky: 0 })).toBe("not run");
  });
});

describe("noiseCheckField", () => {
  it("is 'not run' for no check and not_evaluated for every computed check, k < 2 included", async () => {
    const { noiseCheck } = await import("../../src/feedback/noise.js");
    expect(noiseCheckField(null)).toBe("not run");
    expect(noiseCheckField(noiseCheck({ k: 3, flaky_train: 0, flaky_test: null }))).toBe("not_evaluated");
    expect(noiseCheckField(noiseCheck({ k: 1, flaky_train: 2, flaky_test: null }))).toBe("not_evaluated");
  });
});
