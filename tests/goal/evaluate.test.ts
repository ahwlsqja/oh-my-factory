import { describe, expect, it } from "vitest";
import { evaluateTarget } from "../../src/goal/evaluate.js";

describe("evaluateTarget", () => {
  it("is met with no gap when the operator holds", () => {
    const met = { met: true, gap: 0, direction: "none", relative: 0, size: "none" };
    expect(evaluateTarget({ operator: "<=", value: 250 }, 200)).toEqual(met);
    expect(evaluateTarget({ operator: ">=", value: 0.9 }, 0.95)).toEqual(met);
    expect(evaluateTarget({ operator: "==", value: 0 }, 0)).toEqual(met);
  });

  it("reports the direction and size of the gap", () => {
    expect(evaluateTarget({ operator: "<=", value: 250 }, 312)).toEqual({
      met: false,
      gap: 62,
      direction: "decrease",
      relative: 0.248,
      size: "medium",
    });
    expect(evaluateTarget({ operator: ">=", value: 100 }, 95)).toMatchObject({ direction: "increase", size: "small" });
    expect(evaluateTarget({ operator: ">=", value: 100 }, 40)).toMatchObject({ direction: "increase", size: "large" });
    expect(evaluateTarget({ operator: "==", value: 10 }, 12)).toMatchObject({ direction: "decrease" });
    expect(evaluateTarget({ operator: "==", value: 10 }, 8)).toMatchObject({ direction: "increase" });
  });

  it("has no relative gap for a zero target", () => {
    expect(evaluateTarget({ operator: "==", value: 0 }, 3)).toEqual({
      met: false,
      gap: 3,
      direction: "decrease",
      relative: null,
      size: "large",
    });
  });
});
