import { describe, expect, it } from "vitest";
import { evaluateGate1 } from "../../src/decision/gate1.js";
import { scenarioLinkCoverage } from "../../src/decision/lint.js";
import type { DecisionState } from "../../src/decision/types.js";
import { runDecideAdd, runDecideResolve } from "../../src/cli/decide.js";
import { HUMAN, NOW, addOpen, closeInterface, reportAt, resolveOpen, setupDecisionItem } from "../helpers/decision-fixture.js";

// Spec §5.0: GATE-1 (decisions) and GATE-2 (seal) are different gates. The scenario-link rule belongs to GATE-2.
// If GATE-1 also asked for links, no item could ever reach S2, where the scenarios are written: a deadlock.
// This guards that, with a local GATE-2 stub standing in for the real one.

type Gate2Stub =
  | { status: "pass"; not_run: string[] }
  | { status: "back_to_S2"; unlinked: string[]; not_run: string[] };

/** What GATE-2 will do with the link rule (M3c): unlinked non-quantitative decisions send the item back to S2. */
function gate2Stub(state: DecisionState, linked: ReadonlySet<string>): Gate2Stub {
  const { unlinked, not_run } = scenarioLinkCoverage(state, linked);
  return unlinked.length === 0 ? { status: "pass", not_run } : { status: "back_to_S2", unlinked, not_run };
}

describe("W-gate1-then-gate2-walk", () => {
  it("passes GATE-1 with nothing linked, and only the GATE-2 stub asks for links", () => {
    const f = setupDecisionItem();
    closeInterface(f);
    addOpen(f, "d-cache", "compatibility");
    resolveOpen(f, "d-cache");
    runDecideAdd(f.fx.location, f.workId, { id: "d-latency", class: "latency", question: "How fast must a lookup be?" }, "omf");
    runDecideResolve(
      f.fx.location,
      f.workId,
      "d-latency",
      {
        choice: "Bounded lookup time",
        rationale: "Callers wait on it.",
        rejected: [],
        response_measure: { metric: "cache lookup time", op: "<=", threshold: 40, unit: "ms", percentile: 95, window: null },
      },
      HUMAN,
    );

    const report = reportAt(f, NOW);
    expect(report.gate).toEqual({ status: "pass" });
    expect(report.problems.filter((p) => p.code === "unlinked")).toEqual([]);
    expect(evaluateGate1.length, "GATE-1 takes (state, now, ctx) and no link input").toBe(3);

    const coverage = scenarioLinkCoverage(report.state, new Set<string>());
    expect(coverage.unlinked).toEqual(expect.arrayContaining(["d-cache", "d-interface"]));
    expect(coverage.unlinked).not.toContain("d-latency");
    expect(coverage.not_run, "quantitative decisions are not_run, never unlinked and never success").toEqual(["d-latency"]);

    const back = gate2Stub(report.state, new Set<string>());
    expect(back.status).toBe("back_to_S2");
    expect(gate2Stub(report.state, new Set(coverage.unlinked))).toEqual({ status: "pass", not_run: ["d-latency"] });
  });

  it.todo("the real seal and GATE-2 walk: GATE-1 pass, seal, links complete (M3c)");
});
