import { beforeEach, describe, expect, it, vi } from "vitest";
import { JudgeRoundError } from "../../src/judge/round.js";
import { RUN, runRound, scenarioOf, stepOf } from "../helpers/judge-fixture.js";
import { resetMeasureHook } from "../helpers/measure-mock.js";
import { exited, RuntimeDouble } from "../helpers/sut-double.js";

vi.mock("../../src/container/measure.js", async () => (await import("../helpers/measure-mock.js")).measureMockModule());
beforeEach(resetMeasureHook);

// Spec 5.5: the host relays; it never executes scenario content, and the SUT never sees an expectation.
const HOSTILE = ["--privileged", "-v /:/host", "; rm -rf /", "$(id)", "`id`", "a\nb"];
const EXPECTED_TEXT = "EXPECTED-OUTPUT-TEXT";

describe("W-relay-data-only", () => {
  it("gives the SUT hostile argv and stdin only as exec argv elements and the stdin channel", async () => {
    const double = new RuntimeDouble(() => exited("x"));
    const step = { ...stepOf(HOSTILE, 0, EXPECTED_TEXT), invoke: { argv: HOSTILE, stdin: "line\u0000two" } };
    await runRound(double, [scenarioOf(1, [step])], { k: 2 });
    expect(double.sutExecs).toHaveLength(2);
    for (const exec of double.sutExecs) {
      expect(exec.argv).toEqual([...RUN, ...HOSTILE]);
      expect(exec.stdin).toBe("line\u0000two");
      expect(["sh", "bash", "/bin/sh", "-c"]).not.toContain(exec.argv[0]);
    }
  });

  it("shows the SUT no expectation, no assertion text, no canary and no bind or socket", async () => {
    const double = new RuntimeDouble(() => exited("x"));
    await runRound(double, [scenarioOf(1, [stepOf(["list"], 0, EXPECTED_TEXT)])], { k: 2 });
    const seen = JSON.stringify([double.sutExecs, double.specs.filter((spec) => spec.labels.role === "sut")]);
    expect(seen).not.toContain(EXPECTED_TEXT);
    expect(seen).not.toContain("omf-canary-");
    expect(seen).not.toMatch(/bind|mount|volume|docker\.sock|privileged/i);
  });

  it("treats a harness that substitutes the next step as a failed round, not as a command to relay", async () => {
    const double = new RuntimeDouble(() => exited(""));
    double.tamper = (request, reply) =>
      request.op === "observe" && reply.op === "observe" && reply.next !== null
        ? { ...reply, next: { argv: ["--evil"], stdin: "" } }
        : reply;
    const rejected = runRound(double, [scenarioOf(1, [stepOf(["a"], 0), stepOf(["b"], 0)])], { k: 2 });
    await expect(rejected).rejects.toBeInstanceOf(JudgeRoundError);
    await expect(rejected).rejects.toMatchObject({ code: "verdict_mismatch" });
    expect(double.sutExecs.flatMap((exec) => exec.argv)).not.toContain("--evil");
  });
});
