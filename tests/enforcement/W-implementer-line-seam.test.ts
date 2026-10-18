import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NOT_ENFORCED_LINE } from "../../src/work/evidence.js";
import { type ImplementerLineRun, omfRefs, runImplementerLine } from "../helpers/implementer-line.js";
import { eventsOfType } from "../helpers/line-m3f.js";
import { gitIn } from "../helpers/tmp.js";

// M3g, M3-D15: the line with the real implementer station. The author container is M3h, so without a seam the author
// stage stays unmeasured and GATE-3 stops the line; the seam variant appends the author measurement itself and shows the
// line's logic, not a sealing proof (spec §7).
const gate3 = (run: ImplementerLineRun): { verdict: string; reasons: string[] } => {
  const last = run.result.evidence.gates.history.filter((entry) => entry.gate === "GATE-3").at(-1);
  if (last === undefined) throw new Error("GATE-3 never ran");
  return last;
};
const evidenceMd = (run: ImplementerLineRun): string => readFileSync(join(run.jl.l.f.item.dir, "evidence.md"), "utf8");
const stagesOf = (run: ImplementerLineRun): string[] =>
  [...new Set(eventsOfType(run, "isolation.measured").map((event) => String(event.payload.stage)))].sort();

describe("W-implementer-line-seam", () => {
  it("(a) real state: S3 measures the implementer stage, the line still stops at GATE-3 with isolation unmeasured", async () => {
    const run = await runImplementerLine();
    expect(run.result.outcome).toBe("blocked");
    expect(run.result.reason_code).toBe("gate_blocked");
    expect(gate3(run).verdict).toBe("fail");
    expect(gate3(run).reasons).toContain("isolation_unmeasured");
    expect(stagesOf(run), "the real S3 and S4 measured their containers and nothing measured the author").toEqual([
      "harness",
      "implementer",
      "sut",
    ]);
    const implementer = eventsOfType(run, "isolation.measured").find((event) => event.payload.stage === "implementer");
    expect(implementer?.payload.level, "the implementer container is golden on the fake daemon").toBe("L2");
    const text = evidenceMd(run);
    expect(text).toContain(NOT_ENFORCED_LINE);
    expect(text).toContain("- isolation level: unmeasured");
    expect(text).not.toMatch(/isolation level: L[123]/);
    expect(eventsOfType(run, "feedback.test_run_consumed"), "GATE-3 stops the line before S6").toEqual([]);
    expect(run.jl.liveContainers(), "the combined line end removed every container").toEqual([]);
    // The candidate was published for review; that is the only change the line made to the user's repository.
    expect(omfRefs(run.userRepo)).toEqual([`refs/heads/omf/${run.workId}`]);
    expect(gitIn(run.userRepo, "rev-parse", "refs/heads/main").trim()).toBe(run.mainBefore);
    expect(gitIn(run.userRepo, "status", "--porcelain")).toBe("");
  });

  it("(b) seam: with the author measurement appended by the test the line reaches GATE-3 logic and ends success, human_needed", async () => {
    const run = await runImplementerLine({ seam: true });
    expect(run.result.outcome).toBe("success");
    expect(run.result.evidence.recommendation).toBe("human_needed");
    expect(gate3(run)).toMatchObject({ verdict: "pass", reasons: [] });
    expect(stagesOf(run)).toEqual(["author", "harness", "implementer", "sut"]);
    expect(evidenceMd(run)).toContain("- isolation level: L2");
    expect(run.result.evidence.sealed).toEqual({ train: { pass: 2, total: 2, flaky: 0 }, test: { pass: 1, total: 1 } });
    // The implementer's own words reach the evidence only as untrusted text.
    expect(run.result.evidence.untrusted_fields).toEqual(["plan_summary", "implementer_notes"]);
    expect(String(run.result.evidence.plan_summary)).toContain("make add return the sum");
    expect(eventsOfType(run, "implementer.base_fixed")).toHaveLength(1);
    expect(eventsOfType(run, "implementer.candidate_checked").map((event) => event.payload)).toEqual([
      expect.objectContaining({ plan: "ok", request: "none", scan: "clean", published: true }),
    ]);
    expect(run.jl.liveContainers()).toEqual([]);
  });
});
