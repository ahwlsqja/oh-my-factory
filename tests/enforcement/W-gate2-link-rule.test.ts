import { describe, expect, it } from "vitest";
import { evaluateGate2, sealFeedbackFor } from "../../src/scenario/gate2.js";
import { effective, passingInput, rebuild } from "../helpers/gate2-input.js";

// Spec §5.0 and §5.3: GATE-1 asks for no link (it would deadlock S2), GATE-2 does. A resolved decision that no active
// behavior scenario names sends the item back to S2 with the decision id and nothing else. Quantitative decisions are
// exempt: a CLI scenario cannot prove a latency figure in v0.1, so they are `not_run`, and a scenario that names one
// buys no coverage (M3-D17, M3c-D8). A canary names no coverage either.

describe("W-gate2-link-rule", () => {
  it("an unlinked resolved decision is back_to_S2 with exactly its id; a canary that names it does not link it", () => {
    const input = rebuild(passingInput(), [
      effective({ kind: "behavior", split: "train", refs: ["d-interface"] }),
      effective({ kind: "behavior", split: "test", refs: [] }),
      effective({ kind: "contradiction_canary", split: "train", refs: ["d-cache"] }),
    ]);
    const result = evaluateGate2(input);
    expect(result.status).toBe("fail");
    if (result.status !== "fail") return;
    expect(result.route).toBe("back_to_S2");
    expect(result.reasons).toEqual([{ code: "unlinked_decisions", count: 1, decision_ids: ["d-cache"] }]);
    expect(result.not_run, "the quantitative decision is listed, never unlinked and never success").toEqual([
      "d-latency",
    ]);

    const feedback = sealFeedbackFor(result);
    expect(feedback).toEqual({ unlinked_decision_ids: ["d-cache"], weak: 0, contradictions: 0, invalid: 0 });
    expect(Object.keys(feedback ?? {}).sort(), "no other content reaches the next seal prompt").toEqual([
      "contradictions",
      "invalid",
      "unlinked_decision_ids",
      "weak",
    ]);
    const text = JSON.stringify(feedback);
    for (const entry of input.effective) {
      expect(text).not.toContain(entry.scenario.scenario_id);
      expect(text).not.toContain(entry.scenario.canary);
    }
  });

  it("linking every non-quantitative decision passes, with the quantitative one as not_run", () => {
    const result = evaluateGate2(passingInput());
    expect(result.status).toBe("pass");
    expect(result.not_run).toEqual(["d-latency"]);
  });

  it("a scenario that names the quantitative decision is scenario_invalid, and the decision stays not_run", () => {
    const input = {
      ...rebuild(passingInput(), [
        effective({ kind: "behavior", split: "train", refs: ["d-interface", "d-latency"] }),
        effective({ kind: "behavior", split: "test", refs: ["d-cache"] }),
        effective({ kind: "contradiction_canary", split: "train" }),
      ]),
      problems: [
        { code: "decision_quantitative" as const, scenario_ref: "0123456789abcdef", decision_id: "d-latency" },
      ],
    };
    const result = evaluateGate2(input);
    expect(result.status).toBe("fail");
    if (result.status !== "fail") return;
    expect(result.reasons).toEqual([{ code: "scenario_invalid", count: 1 }]);
    expect(result.not_run).toEqual(["d-latency"]);
    expect(sealFeedbackFor(result)).toEqual({ unlinked_decision_ids: [], weak: 0, contradictions: 0, invalid: 1 });
  });
});
