import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { behavior, canaryScenario, type ScenarioSpec } from "../helpers/line-fixture.js";
import { eventsOfType, runSeamLine, type SeamRun } from "../helpers/line-m3f.js";

// SEAM test (spec §7). The whole line S1..S7 over a fake daemon, with the author and implementer measurements appended by the
// test itself. It shows the line's logic, one rework round included; it does not show that anything was sealed or isolated, so
// it maps to no requirement. Under owner decision O-1 the noise check is never evaluated, so the best a success can say is
// human_needed.

/** Five train behaviours, so masked feedback can be released (fewer is withheld), one contradiction canary, one test behaviour. */
const REWORK_SET: readonly ScenarioSpec[] = [
  behavior(["d-interface"], "train", "zz-distinct-key"),
  behavior(["d-interface"], "train", "k1"),
  behavior(["d-cache"], "train", "k3"),
  behavior(["d-cache"], "train", "k4"),
  behavior(["d-cache"], "train", "k5"),
  canaryScenario("train"),
  behavior(["d-interface"], "test", "k2"),
];

/** Text only a scenario holds: its key, its assertion note, its expected output, its id and its canary. */
const SCENARIO_ONLY = [
  /zz-distinct-key/,
  /UNIQUE-NOTE-PHRASE/,
  /ok-distinct-output/,
  /\bs-[0-9a-f]{32}\b/,
  /omf-canary-[0-9a-f]{32}/,
];

const evidenceMd = (run: SeamRun): string => readFileSync(join(run.jl.l.f.item.dir, "evidence.md"), "utf8");

describe("seam: the whole line with an injected author measurement", () => {
  it("fails the train split in round 1, releases masked feedback, and finishes round 2 as success with human_needed", async () => {
    const run = await runSeamLine({ seam: true, candidate: "fixed_in_round_2", sealSpecs: REWORK_SET });

    // One rework round: round 1 fails the train split, S6 releases feedback, round 2 starts again at S3.
    expect(eventsOfType(run, "work.round")).toHaveLength(2);
    expect(run.result.evidence.self_metrics.rounds).toBe(2);
    const released = eventsOfType(run, "feedback.released");
    expect(released).toHaveLength(1);
    expect(released[0]?.payload.disclosure_units).toBe(1);
    for (const pattern of SCENARIO_ONLY)
      expect(JSON.stringify(released[0]?.payload), `release ${pattern}`).not.toMatch(pattern);
    const types = run.events.map((event) => event.type);
    expect(types.indexOf("feedback.released"), "the test split is spent after the release, not before").toBeLessThan(
      types.indexOf("feedback.test_run_consumed"),
    );
    expect(eventsOfType(run, "feedback.test_run_consumed")).toHaveLength(1);
    expect(eventsOfType(run, "feedback.test_run_completed")).toHaveLength(1);

    // The ceiling of O-1: success, human_needed, never merge_recommended.
    expect(run.result.outcome).toBe("success");
    expect(run.result.evidence.recommendation).toBe("human_needed");
    expect(run.result.evidence.recommendation).not.toBe("merge_recommended");
    const areas = run.result.evidence.unverified_areas.map((area) => area.code);
    expect(areas).toContain("noise_check_not_evaluated");
    // The fixture goal carries a quantitative decision, and the candidate adds tests/calc.test.mjs, a high-risk path.
    const expected = new Set(["decision_unmeasured", "high_risk_paths_touched"]);
    expect(areas.filter((code) => !expected.has(code))).toEqual(["noise_check_not_evaluated"]);
    expect(run.result.evidence.sealed).toEqual({ train: { pass: 5, total: 5, flaky: 0 }, test: { pass: 1, total: 1 } });
    expect(
      run.result.evidence.gates.history
        .filter((entry) => entry.gate === "GATE-3")
        .every((entry) => entry.verdict === "pass"),
    ).toBe(true);

    // The label is L2 only because the test appended the author and implementer measurements.
    expect(evidenceMd(run)).toContain("- isolation level: L2");
    const stages = new Set(eventsOfType(run, "isolation.measured").map((event) => String(event.payload.stage)));
    expect([...stages].sort()).toEqual(["author", "harness", "implementer", "sut"]);
    expect(run.jl.liveContainers(), "every container was destroyed").toEqual([]);
  });
});
