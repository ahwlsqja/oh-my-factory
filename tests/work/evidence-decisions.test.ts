import { describe, expect, it } from "vitest";
import { runDecideAdd, runDecideResolve } from "../../src/cli/decide.js";
import { evidenceDecisions } from "../../src/work/evidence.js";
import { HUMAN, forge, relockTarget, setupDecisionItem, type DecisionFixture } from "../helpers/decision-fixture.js";

const measure = (threshold: number) => ({ metric: "cache lookup time", op: "<=" as const, threshold, unit: "ms", percentile: null, window: null });

/** A resolved latency decision with a numeric threshold, written the way a person and `omf` write it. */
function addLatency(f: DecisionFixture, id: string, threshold: number): void {
  runDecideAdd(f.fx.location, f.workId, { id, class: "latency", question: "How fast must a lookup be?", response_measure: measure(threshold) }, "omf");
  runDecideResolve(f.fx.location, f.workId, id, { choice: "Keep the current behavior", rationale: "Nothing depends on a change.", rejected: [] }, HUMAN);
}

const decisionsOf = (f: DecisionFixture, item = f.item) => evidenceDecisions(f.fx.location, item, f.fx.ledger.readVerified());

describe("evidenceDecisions", () => {
  it("lists quantitative decisions only, with the threshold and measured: not run", () => {
    const f = setupDecisionItem();
    addLatency(f, "d-latency", 250);
    runDecideAdd(f.fx.location, f.workId, { id: "d-cache", class: "other", question: "Should the cache survive a restart?" }, "omf");
    expect(decisionsOf(f)).toEqual({ list: [{ id: "d-latency", threshold: 250, measured: "not run", status: "resolved" }], masked: false });
  });

  it("drops a threshold that equals the locked target after a re-lock, and says something was left out", () => {
    const f = setupDecisionItem();
    addLatency(f, "d-latency", 250);
    relockTarget(f, 250);
    const result = decisionsOf(f);
    expect(result).toEqual({ list: [], masked: true });
    expect(JSON.stringify(result)).not.toMatch(/d-latency|250/);
  });

  it("drops a decision whose id carries the metric, keeps the clean one", () => {
    const f = setupDecisionItem();
    addLatency(f, "d-latency", 250);
    // written straight into the ledger, as someone with write access would, so no writer refused the id
    forge(f, "omf", "decision.added", "d-zebra-quokka", { class: "latency", question: "How fast must a lookup be?", response_measure: measure(40) });
    const result = decisionsOf(f);
    expect(result.list.map((decision) => decision.id)).toEqual(["d-latency"]);
    expect(result.masked).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/zebra|quokka/);
  });

  it("lists nothing and says so when the leak context cannot be loaded", () => {
    const f = setupDecisionItem();
    addLatency(f, "d-latency", 250);
    const unlocked = { ...f.item, front: { ...f.item.front, goal_id: "g-unlocked" } };
    expect(decisionsOf(f, unlocked)).toEqual({ list: [], masked: true });
  });
});
