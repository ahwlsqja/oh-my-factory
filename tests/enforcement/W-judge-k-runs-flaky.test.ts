import { beforeEach, describe, expect, it, vi } from "vitest";
import { JudgeRoundError } from "../../src/judge/round.js";
import { ref, runRound, scenarioOf, stepOf } from "../helpers/judge-fixture.js";
import { resetMeasureHook } from "../helpers/measure-mock.js";
import { type Candidate, exited, RuntimeDouble } from "../helpers/sut-double.js";

vi.mock("../../src/container/measure.js", async () => (await import("../helpers/measure-mock.js")).measureMockModule());
beforeEach(resetMeasureHook);

// Spec 5.5, M3f-D8: k reps; mixed pass and fail is flaky, never a pass; a stop the candidate causes is a fail, never an
// environment error; only a runtime fault is `error`, and any `error` fails the round.
let flips = 0;
beforeEach(() => {
  flips = 0;
});
const candidate: Candidate = ({ argv, state }) => {
  switch (argv[1]) {
    case "flip":
      flips += 1;
      return exited("", flips % 2 === 1 ? 0 : 1);
    case "bad":
      return exited("", 1);
    case "timeout":
      return { kind: "timeout", stdout: "", stderr: "" };
    case "limit":
      return { kind: "output_limit", stdout: "", stderr: "" };
    case "utf8":
      return exited("�");
    case "dead":
      state.dead = true;
      return { kind: "error", code: "EIO", message: "gone" };
    case "fault":
      return { kind: "error", code: "EIO", message: "client failed" };
    default:
      return exited("");
  }
};
const scenario = (n: number, tag: string) => scenarioOf(n, [stepOf([tag], 0)]);

describe("W-judge-k-runs-flaky", () => {
  it("counts a scenario that passes in some reps and fails in others as flaky, not as pass", async () => {
    const verdict = await runRound(
      new RuntimeDouble(candidate),
      [scenario(1, "ok"), scenario(2, "flip"), scenario(3, "bad")],
      {
        k: 2,
      },
    );
    expect(verdict.tallies.map((tally) => [tally.scenario_ref, tally.verdict, tally.outcomes])).toEqual([
      [ref(1), "pass", ["pass", "pass"]],
      [ref(2), "flaky", ["pass", "fail"]],
      [ref(3), "fail", ["fail", "fail"]],
    ]);
    expect(verdict.counts).toEqual({ total: 3, pass: 1, fail: 1, flaky: 1, error: 0 });
  });

  it("scores a timeout, an output limit, invalid UTF-8 and a dead container as fail, never as error", async () => {
    const verdict = await runRound(
      new RuntimeDouble(candidate),
      [scenario(1, "timeout"), scenario(2, "limit"), scenario(3, "utf8"), scenario(4, "dead")],
      { k: 2 },
    );
    expect(verdict.tallies.map((tally) => tally.verdict)).toEqual(["fail", "fail", "fail", "fail"]);
    expect(verdict.counts).toEqual({ total: 4, pass: 0, fail: 4, flaky: 0, error: 0 });
  });

  it("fails the round when a runtime fault makes a scenario error", async () => {
    const rejected = runRound(new RuntimeDouble(candidate), [scenario(1, "ok"), scenario(2, "fault")], { k: 2 });
    await expect(rejected).rejects.toBeInstanceOf(JudgeRoundError);
    await expect(rejected).rejects.toMatchObject({ code: "round_error" });
  });

  it("keeps canaries out of the behavior counts and counts only the ones failed in every rep as rejected", async () => {
    const verdict = await runRound(
      new RuntimeDouble(candidate),
      [
        scenario(1, "ok"),
        scenarioOf(2, [stepOf(["bad"], 0)], { kind: "contradiction_canary", split: "test" }),
        scenarioOf(3, [stepOf(["flip"], 0)], { kind: "contradiction_canary" }),
      ],
      { k: 2 },
    );
    expect(verdict.counts).toEqual({ total: 1, pass: 1, fail: 0, flaky: 0, error: 0 });
    expect(verdict.contradiction).toEqual({ scenarios: 2, rejected: 1 });
  });
});
