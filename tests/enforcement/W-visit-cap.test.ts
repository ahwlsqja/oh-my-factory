import { describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS } from "../../src/core/config.js";
import { type Gate, type GateResult } from "../../src/work/gates.js";
import { VisitCounter, evaluateGate4, totalVisitCap } from "../../src/work/gate4.js";
import { classifyOutcome, toOutcomeInput } from "../../src/work/classify.js";
import { HANDOFF_ROUTES } from "../../src/work/handoff.js";
import type { NodeId } from "../../src/work/line-types.js";
import { dispositionOf } from "../../src/work/outcome.js";
import { type WorkBudgetState, microUsd } from "../../src/work/w-budget.js";
import { classifierInput, finished, passGate, setupLine } from "../helpers/line-enforce.js";

// Spec §4.4: loops are capped per node per round and in total. The cap is on with the default limits
// (Kilroy's 0 would turn it off). Through `runLine` only the S2/GATE-2 loop of round 0 can reach a cap: from
// round 1 on each node is visited once per round (S6 rework opens a new round and resets the counts). The
// caps of round >= 1 and the total cap are therefore exercised through GATE-4 and the classifier, which is
// where a future routing change would meet them.
function budgetOf(rounds: number, usd: number): WorkBudgetState {
  const limits = { max_rounds: rounds, max_model_micro_usd: microUsd(usd) };
  return {
    limits,
    raised: { rounds: 0, model_micro_usd: 0 },
    effective: limits,
    rounds_started: 1,
    previous_signature: null,
    spend: { micro_usd: 0, unknown_count: 0 },
    anomalies: [],
  };
}

function gate4(visits: { in_round: number; total: number }, entering: NodeId) {
  return evaluateGate4({
    budget: budgetOf(CONFIG_DEFAULTS.w.max_rounds, CONFIG_DEFAULTS.w.max_model_usd),
    visits: { ...visits, entering },
    next_round_wanted: false,
    stall: { current: null, rework: false },
    reentry: { same_reason: 0, kills: 0 },
  });
}

describe("W-visit-cap", () => {
  it("the fourth S2 visit in round 0 parks the still-ready item with a J3 handoff and starts nothing", async () => {
    const line = setupLine();
    let gate2Calls = 0;
    const stuck: Gate = {
      id: "GATE-2",
      evaluate: (): GateResult => {
        gate2Calls += 1;
        return { gate: "GATE-2", verdict: "fail", reasons: ["scenarios_missing"] };
      },
    };
    const { result, ran } = await line.exec({ gates: { "GATE-2": stuck } });
    const done = finished(result);
    expect(done).toMatchObject({ outcome: "blocked", reason_code: "gate2_exhausted", disposition: { action: "park" } });
    expect(ran).toEqual(["S1", "S2", "S2", "S2"]);
    expect(gate2Calls).toBe(3);
    expect(done.evidence.gates.history).toContainEqual({ gate: "GATE-4", verdict: "fail", reasons: ["visit_cap"] });
    expect(done.handoff?.decision_required.j).toBe("J3");
    expect(line.state()).toBe("ready");
    expect(line.types()).not.toContain("work.started");
    expect(line.types()).not.toContain("work.round");
    expect(line.types().at(-1)).toBe("work.parked");
  });

  it("control: a GATE-2 that passes on the third visit continues past S2", async () => {
    const line = setupLine();
    let calls = 0;
    const third: Gate = {
      id: "GATE-2",
      evaluate: (): GateResult => {
        calls += 1;
        return {
          gate: "GATE-2",
          verdict: calls < 3 ? "fail" : "pass",
          reasons: calls < 3 ? ["scenarios_missing"] : [],
        };
      },
    };
    const { result, ran } = await line.exec({ gates: { "GATE-2": third, "GATE-3": passGate("GATE-3") } });
    expect(finished(result).reason_code).not.toBe("gate2_exhausted");
    expect(ran.filter((id) => id === "S2")).toHaveLength(3);
    expect(ran).toContain("S3");
  });

  it("with the default limits the fourth visit of a node in a round >= 1 ends the item failed (J6)", () => {
    const counter = new VisitCounter();
    counter.startRound();
    counter.enter("S4");
    counter.enter("S4");
    const third = counter.enter("S4");
    const fourth = counter.enter("S4");
    expect([counter.round, third.in_round, fourth.in_round]).toEqual([1, 3, 4]);
    expect(gate4(third, "S4").verdict).toBe("pass");

    const stop = gate4(fourth, "S4");
    expect(stop).toMatchObject({ verdict: "fail", severity: "hard", reasons: ["visit_cap"] });
    const classification = classifyOutcome(
      classifierInput({ stop: { kind: "gate4", severity: "hard", reasons: stop.reasons, round: counter.round } }),
    );
    expect(classification).toMatchObject({
      outcome: "flawed",
      exhausted: true,
      reason_code: "visit_cap",
      rule: "gate4_hard",
    });
    expect(dispositionOf(toOutcomeInput(classification))).toMatchObject({ action: "fail", item_state: "failed" });
    expect(HANDOFF_ROUTES.visit_cap.j).toBe("J6");
  });

  it("the total cap is max(10, 20 x max_rounds) and counts gates; it is on by default", () => {
    expect([0, 1, 3].map((rounds) => totalVisitCap(rounds))).toEqual([10, 20, 60]);
    const cap = totalVisitCap(CONFIG_DEFAULTS.w.max_rounds);
    expect(gate4({ in_round: 1, total: cap }, "GATE-3").verdict).toBe("pass");
    expect(gate4({ in_round: 1, total: cap + 1 }, "GATE-3")).toMatchObject({
      verdict: "fail",
      severity: "hard",
      reasons: ["total_visit_cap"],
    });
  });
});
