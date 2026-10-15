import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NOT_ENFORCED_LINE } from "../../src/work/evidence.js";
import { type SeamOptions, type SeamRun, eventsOfType, runSeamLine } from "../helpers/line-m3f.js";

// The whole line S1..S7 over a fake Docker, with a stub author (S2), a stub implementer (S3, behind CandidateSource)
// and the real S4, S5, S6, GATE-2 and GATE-3. No model, no daemon. Cases marked "seam" append the author and implementer
// measurements that M3g and M3h will make: they show the line's logic, they do not prove isolation or sealing.

const gate3 = (run: SeamRun): { verdict: string; reasons: string[] } => {
  const last = run.result.evidence.gates.history.filter((entry) => entry.gate === "GATE-3").at(-1);
  if (last === undefined) throw new Error("GATE-3 never ran");
  return last;
};
const evidenceMd = (run: SeamRun): string => readFileSync(join(run.jl.l.f.item.dir, "evidence.md"), "utf8");
const stagesOf = (run: SeamRun): string[] =>
  [...new Set(eventsOfType(run, "isolation.measured").map((event) => String(event.payload.stage)))].sort();

/** Text only a scenario holds: its assertion note, its id and its canary. The expected output is host-only too. */
const SCENARIO_ONLY = [/UNIQUE-NOTE-PHRASE/, /\bs-[0-9a-f]{32}\b/, /omf-canary-[0-9a-f]{32}/];

function expectHostKeepsScenarioTextOut(run: SeamRun): void {
  const evidence = ["evidence.json", "evidence.md"].map((name) =>
    readFileSync(join(run.jl.l.f.item.dir, name), "utf8"),
  );
  const surfaces = {
    ledger: readFileSync(run.jl.l.f.fx.ledger.file, "utf8"),
    evidence: evidence.join("\n"),
    result: JSON.stringify(run.result),
  };
  for (const [name, text] of Object.entries(surfaces)) {
    for (const pattern of [...SCENARIO_ONLY, /ok-distinct-output/])
      expect(text, `${name} ${pattern}`).not.toMatch(pattern);
  }
}

function expectSutBlind(run: SeamRun): void {
  const seen = run.jl.sutRecording();
  expect(seen.length, "positive control: the SUT double was reached").toBeGreaterThan(0);
  for (const pattern of [...SCENARIO_ONLY, /stdout_matches|json_path/, /d-interface|d-cache/])
    expect(seen, `SUT recording ${pattern}`).not.toMatch(pattern);
}

describe("full line over a fake Docker (M3f)", () => {
  it("(a) real state: with no author or implementer container the line stops at GATE-3, isolation unmeasured", async () => {
    const run = await runSeamLine({ seam: false });
    expect(run.result.outcome).toBe("blocked");
    expect(run.result.reason_code).toBe("gate_blocked");
    expect(gate3(run).verdict).toBe("fail");
    expect(gate3(run).reasons).toContain("isolation_unmeasured");
    expect(stagesOf(run), "S4 measured the judge stages and nothing measured the others").toEqual(["harness", "sut"]);
    const text = evidenceMd(run);
    expect(text).toContain(NOT_ENFORCED_LINE);
    expect(text).toContain("- isolation level: unmeasured");
    expect(text).not.toMatch(/isolation level: L[123]/);
    expect(eventsOfType(run, "feedback.test_run_consumed"), "GATE-3 stops the line before S6").toEqual([]);
    expect(run.jl.liveContainers()).toEqual([]);
    expectHostKeepsScenarioTextOut(run);
    expectSutBlind(run);
  });

  it("(b) seam: a good candidate with all four stages measured reaches success, human_needed, never merge_recommended", async () => {
    const run = await runSeamLine({ seam: true });
    expect(run.result.outcome).toBe("success");
    expect(run.result.evidence.recommendation).toBe("human_needed");
    expect(run.result.evidence.unverified_areas.map((area) => area.code)).toContain("noise_check_not_evaluated");
    expect(gate3(run)).toMatchObject({ verdict: "pass", reasons: [] });
    expect(run.result.evidence.sealed).toEqual({ train: { pass: 2, total: 2, flaky: 0 }, test: { pass: 1, total: 1 } });
    expect(evidenceMd(run)).toContain("- isolation level: L2");
    expect(stagesOf(run)).toEqual(["author", "harness", "implementer", "sut"]);
    expect(eventsOfType(run, "judge.round_completed").map((event) => event.payload.phase)).toEqual(["train", "test"]);
    expect(eventsOfType(run, "feedback.test_run_consumed")).toHaveLength(1);
    expect(eventsOfType(run, "feedback.test_run_completed")).toHaveLength(1);
    expect(run.jl.liveContainers(), "every container was destroyed").toEqual([]);
    expectHostKeepsScenarioTextOut(run);
    expectSutBlind(run);
  });

  interface Negative {
    name: string;
    run: Omit<SeamOptions, "seam">;
    outcome: "flawed" | "blocked";
    reason: string;
    gate3: readonly ["pass" | "fail", string | null];
    marks: number;
  }
  // Each row changes one input of case (b) and must leave success.
  const NEGATIVE: readonly Negative[] = [
    {
      name: "a canary on the implementer prompt",
      run: { candidate: "canary_in_prompt" },
      outcome: "flawed",
      reason: "audit_flag",
      gate3: ["fail", "canary_hit"],
      marks: 1,
    },
    {
      name: "an edited existing test",
      run: { candidate: "edits_test" },
      outcome: "flawed",
      reason: "audit_flag",
      gate3: ["pass", null],
      marks: 0,
    },
    {
      name: "a RED gate line",
      run: { candidate: "red_gate" },
      outcome: "flawed",
      reason: "gates_failed",
      gate3: ["pass", null],
      marks: 0,
    },
    {
      name: "a harness digest that drifts inside the run",
      run: { drift: true },
      outcome: "blocked",
      reason: "gate_blocked",
      gate3: ["fail", "judge_config_changed"],
      marks: 0,
    },
    {
      name: "a judge that accepts the contradiction canary",
      run: { acceptsContradiction: true },
      outcome: "blocked",
      reason: "gate_blocked",
      gate3: ["fail", "contradiction_canary_passing"],
      marks: 0,
    },
  ];

  it.each(NEGATIVE)("seam: $name never succeeds and never spends the test split", async (row) => {
    const run = await runSeamLine({ seam: true, ...row.run });
    expect(run.result.outcome).toBe(row.outcome);
    expect(run.result.reason_code).toBe(row.reason);
    expect(run.result.evidence.recommendation).not.toBe("merge_recommended");
    expect(gate3(run).verdict).toBe(row.gate3[0]);
    if (row.gate3[1] !== null) expect(gate3(run).reasons).toContain(row.gate3[1]);
    expect(eventsOfType(run, "scenario.status_changed")).toHaveLength(row.marks);
    expect(eventsOfType(run, "feedback.test_run_consumed")).toEqual([]);
    expect(run.jl.liveContainers()).toEqual([]);
    expectHostKeepsScenarioTextOut(run);
  });

  it("seam: a candidate that does nothing fails the train split, never succeeds and never spends the test split", async () => {
    const run = await runSeamLine({ seam: true, candidate: "null_impl" });
    expect(run.result.outcome).not.toBe("success");
    expect(run.result.evidence.recommendation).not.toBe("merge_recommended");
    expect(run.result.evidence.sealed.train).toMatchObject({ pass: 0, total: 2 });
    expect(eventsOfType(run, "feedback.test_run_consumed")).toEqual([]);
    expect(run.jl.liveContainers()).toEqual([]);
  });
});
