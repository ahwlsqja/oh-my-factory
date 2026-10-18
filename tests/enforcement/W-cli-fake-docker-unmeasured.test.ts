import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { type EvidenceDoc, NOT_ENFORCED_LINE, readEvidence } from "../../src/work/evidence.js";
import { handoffFile } from "../../src/work/handoff.js";
import { type CliLine, type CliResult, setupCliLine } from "../helpers/cli-line.js";
import { verbOf } from "../helpers/fake-docker.js";
import { omfRefs } from "../helpers/implementer-line.js";
import { gitIn } from "../helpers/tmp.js";

// covers: S7.unmeasured-stage-no-claim
//
// The line through the shipped CLI over a stateful `docker` program on PATH. The seal is planted by a stub author stamped
// `host_command`, so no container ever measured the author stage. The pipeline must then say so: GATE-3 fails
// `isolation_unmeasured` (route J7), the run-level label stays `unmeasured`, and nothing printed claims L2 or a container seal.
// Wiring, not proof: the measurement trusts the docker client on PATH, and this fixture simply leaves the author unanswered.

const ISOLATION_CLAIMS = [/isolation level: L[123]/, /sealed \(container\)/];

describe("W-cli-fake-docker-unmeasured", () => {
  let line: CliLine;
  let run: CliResult;
  let doc: EvidenceDoc;

  beforeAll(async () => {
    line = await setupCliLine();
    run = line.cli(["run", line.workId]);
    const read = readEvidence(line.l.f.item.dir);
    if (!read.ok) throw new Error(`no evidence after the run (exit ${run.code}): ${run.stdout}${run.stderr}`);
    doc = read.doc;
  }, 180_000);

  it("warns before it spends, then ends blocked at GATE-3 with a J7 handoff and exit 2", () => {
    expect(
      line.bin.state().calls.some((call) => verbOf(call.argv) === "exec"),
      "the fake daemon was reached",
    ).toBe(true);
    expect(run.code, `${run.stdout}${run.stderr}`).toBe(2);
    expect(`${run.stdout}${run.stderr}`).toContain("warning: the author stage is unmeasured");
    const parked = line.events("work.parked").at(-1);
    expect(parked?.payload).toMatchObject({ outcome: "blocked", reason_code: "gate_blocked" });
    expect(doc.outcome).toBe("blocked");
    expect(doc.recommendation_reasons[0]).toBe("gate3_blocked");
    const gate3 = doc.gates.history.filter((entry) => entry.gate === "GATE-3").at(-1);
    expect(gate3).toMatchObject({ verdict: "fail" });
    expect(gate3?.reasons).toContain("isolation_unmeasured");
    const file = handoffFile(line.l.f.item.dir, String(parked?.payload.run_id), "outcome");
    const handoff = JSON.parse(readFileSync(file, "utf8")) as { decision_required: { j: string } };
    expect(handoff.decision_required.j).toBe("J7");
  });

  it("leaves the run-level isolation label unmeasured and prints no sealing claim", () => {
    expect(doc.isolation_level).toBe("unmeasured");
    const md = readFileSync(join(line.l.f.item.dir, "evidence.md"), "utf8");
    expect(md).toContain(NOT_ENFORCED_LINE);
    expect(md).toContain("- isolation level: unmeasured");
    for (const text of [md, run.stdout, run.stderr]) {
      for (const claim of ISOLATION_CLAIMS) expect(text).not.toMatch(claim);
    }
    expect(`${run.stdout}${run.stderr}`).not.toContain("merge_recommended");
    expect(doc.recommendation).not.toBe("merge_recommended");
    // Per-stage L2 events of the implementer, SUT and harness containers are real and allowed; the author has none.
    const measured = line.events("isolation.measured");
    const stages = measured.map((event) => String(event.payload.stage));
    expect(stages).not.toContain("author");
    expect([...new Set(stages)].sort()).toEqual(["harness", "implementer", "sut"]);
    expect(measured.find((event) => event.payload.stage === "implementer")?.payload.level).toBe("L2");
  });

  it("omf report shows the same unmeasured evidence twice, byte for byte, and writes nothing", () => {
    const before = line.events().length;
    const first = line.cli(["report", line.workId]);
    const second = line.cli(["report", line.workId]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain(NOT_ENFORCED_LINE);
    expect(first.stdout).toContain("isolation level: unmeasured");
    expect(first.stdout).toBe(second.stdout);
    for (const claim of ISOLATION_CLAIMS) expect(first.stdout).not.toMatch(claim);
    expect(first.stdout).not.toContain("merge_recommended");
    expect(line.events()).toHaveLength(before);
  });

  it("publishes only the candidate branch to the user's repository, and keeps the key and every container out", () => {
    const { userRepo, mainBefore, workId, key } = line;
    expect(omfRefs(userRepo)).toEqual([`refs/heads/omf/${workId}`]);
    expect(gitIn(userRepo, "rev-parse", "refs/heads/main").trim()).toBe(mainBefore);
    expect(gitIn(userRepo, "status", "--porcelain")).toBe("");
    const surfaces = [
      run.stdout,
      run.stderr,
      readFileSync(line.l.f.fx.ledger.file, "utf8"),
      JSON.stringify(line.bin.state()),
    ];
    for (const text of surfaces) expect(text).not.toContain(key);
    expect(line.containers(), "the combined line end removed every container").toEqual([]);
  });
});
