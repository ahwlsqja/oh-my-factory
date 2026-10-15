import { describe, expect, it } from "vitest";
import { NotGoldenError } from "../../src/container/measure.js";
import { budgetState } from "../../src/core/budget.js";
import { JudgeRoundError } from "../../src/judge/round.js";
import type { TestJudge } from "../../src/judge/s6-station.js";
import { setupLine } from "../helpers/line.js";
import {
  CANDIDATE,
  TEST,
  contextOf,
  declareDisclosure,
  judgeSpy,
  roundState,
  slot,
  spentOf,
  stationOf,
  typesOf,
  verdictOf,
} from "../helpers/s6-fixture.js";

// Spec §5.5 to §5.8: S6 spends the sealed test split once, after GATE-3, and answers with closed codes only.
describe("S6 station, guards", () => {
  it.each([
    ["no round state", null],
    ["another round's state", roundState([], { round: 2 })],
    ["an empty train batch", roundState([], { train: verdictOf("train", [], []) })],
  ])("blocks station_error for %s and writes nothing", async (_label, state) => {
    const l = setupLine();
    const spy = judgeSpy(l);
    const before = l.events().length;

    const result = await stationOf(l, state, spy.judge, slot()).run(contextOf(l));

    expect(result).toEqual({ kind: "blocked", reason_code: "station_error" });
    expect(spy.calls).toEqual([]);
    expect(l.events()).toHaveLength(before);
  });
});

describe("S6 station, the test split", () => {
  it("consumes the split before the run, records the result and reuses it for the same commit", async () => {
    const l = setupLine();
    const spy = judgeSpy(l, ["pass", "pass", "pass", "flaky"]);
    const state = roundState();
    const station = stationOf(l, state, spy.judge, slot());
    const first = contextOf(l);

    expect(await station.run(first)).toMatchObject({
      kind: "ok",
      progress_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    // the behavior scenarios of the test split only: not the train split, not either canary
    expect(spy.calls).toEqual([TEST]);
    // consumed before the judge started, completed after it
    expect(spy.seen[0]).toContain("feedback.test_run_consumed");
    expect(spy.seen[0]).not.toContain("feedback.test_run_completed");
    expect(spentOf(l)).toEqual(["feedback.test_run_consumed", "judge.round_completed", "feedback.test_run_completed"]);
    const round = l.events().find((event) => event.type === "judge.round_completed");
    expect(round?.payload).toMatchObject({
      phase: "test",
      round: 1,
      candidate_sha: CANDIDATE,
      scenarios_total: 4,
      pass: 3,
      fail: 0,
      flaky: 1,
    });
    // no scenario handle reaches the ledger
    expect(JSON.stringify(l.events())).not.toContain(TEST[0]?.scenario_ref);
    // a flaky test scenario is not a pass (M3f-D14)
    expect(first.inputs.sealed.test).toEqual({ pass: 3, total: 4 });
    expect(first.inputs.noise_check).toBe("not_evaluated");

    const second = contextOf(l);
    expect(await station.run(second)).toMatchObject({ kind: "ok" });
    expect(spy.calls).toHaveLength(1);
    expect(second.inputs.sealed.test).toEqual({ pass: 3, total: 4 });
    expect(spentOf(l)).toHaveLength(3);
  });

  it("needs a reseal for another commit's code", async () => {
    const l = setupLine();
    const spy = judgeSpy(l);
    await stationOf(l, roundState(), spy.judge, slot()).run(contextOf(l));

    const other = roundState([], { candidate_sha: "2".repeat(40) });
    const result = await stationOf(l, other, spy.judge, slot()).run(contextOf(l));

    expect(result).toEqual({ kind: "blocked", reason_code: "test_reseal_required" });
    expect(spy.calls).toHaveLength(1);
  });

  it.each([
    ["a round error", new JudgeRoundError("round_error"), "infra_failure"],
    ["a container that is not golden", new NotGoldenError(["privileged"]), "gate_blocked"],
  ] as const)("maps %s to blocked %s and leaves the split consumed and incomplete", async (_label, error, code) => {
    const l = setupLine();
    const failing: TestJudge = async () => {
      throw error;
    };

    expect(await stationOf(l, roundState(), failing, slot()).run(contextOf(l))).toEqual({
      kind: "blocked",
      reason_code: code,
    });
    expect(spentOf(l)).toEqual(["feedback.test_run_consumed"]);

    // the next run finds a consumed, incomplete split: a person must act, nothing runs again
    const retry = judgeSpy(l);
    expect(await stationOf(l, roundState(), retry.judge, slot()).run(contextOf(l))).toEqual({
      kind: "blocked",
      reason_code: "test_run_incomplete",
    });
    expect(retry.calls).toEqual([]);
  });
});

describe("S6 station, a failing train batch", () => {
  it("releases masked feedback, asks for another round and charges nothing for a repeated score", async () => {
    const l = setupLine();
    declareDisclosure(l, 40);
    const feedback = slot();
    const spy = judgeSpy(l);
    const station = stationOf(l, roundState(["pass", "pass", "pass", "pass", "fail", "fail"]), spy.judge, feedback);
    const remaining = (): number | undefined => budgetState(l.fx.ledger, l.fx.goalId, "disclosure")?.remaining;

    const first = await station.run(contextOf(l));

    expect(first).toMatchObject({ kind: "rework", progress_digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(feedback.puts).toHaveLength(1);
    expect(typesOf(l)).toContain("feedback.released");
    expect(remaining()).toBe(39);

    // the same score again: released again (the slot gets the text), no unit spent, the same progress digest
    expect(await station.run(contextOf(l))).toEqual(first);
    expect(feedback.puts).toHaveLength(2);
    expect(remaining()).toBe(39);
    // the split was never touched
    expect(spy.calls).toEqual([]);
    expect(spentOf(l)).toEqual([]);
  });
});
