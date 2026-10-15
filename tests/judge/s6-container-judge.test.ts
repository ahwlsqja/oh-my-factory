import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { forbiddenPaths } from "../../src/container/golden.js";
import type { ContainerRuntime } from "../../src/container/runtime.js";
import { readConfig } from "../../src/core/config.js";
import { runJudgeRound } from "../../src/judge/round.js";
import { containerTestJudge } from "../../src/judge/test-judge.js";
import { locationEnv } from "../../src/vault/line-guard.js";
import { setupLine } from "../helpers/line.js";
import { CANDIDATE, TEST, contextOf, roundState, verdictOf } from "../helpers/s6-fixture.js";

vi.mock("../../src/judge/round.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/judge/round.js")>()),
  runJudgeRound: vi.fn(),
}));

describe("containerTestJudge", () => {
  it("judges the given scenarios as the test phase in the round's images, under the configured limits", async () => {
    const l = setupLine();
    const state = roundState();
    const ctx = contextOf(l);
    const runtime = {} as ContainerRuntime;
    const verdict = verdictOf("test", TEST, []);
    vi.mocked(runJudgeRound).mockResolvedValueOnce(verdict);

    const answered = await containerTestJudge({ location: l.fx.location, runtime })({ ctx, state, scenarios: TEST });

    expect(answered).toBe(verdict);
    expect(runJudgeRound).toHaveBeenCalledTimes(1);
    const call = vi.mocked(runJudgeRound).mock.calls[0]?.[0];
    expect(call).toMatchObject({
      runtime,
      phase: "test",
      candidate_sha: CANDIDATE,
      round: 1,
      scenarios: TEST,
      config: readConfig(l.fx.location.dir).judge,
      measure: {
        runtime,
        itemDir: ctx.item.dir,
        scope: { goal_id: ctx.goalId, work_id: ctx.workId, run_id: ctx.runId },
      },
    });
    expect(call?.images).toBe(state.lease);
    expect(call?.stageRoot).toBe(join(ctx.item.dir, "runs", ctx.runId, "judge"));
    expect(call?.forbidden).toEqual(forbiddenPaths(l.fx.location, locationEnv(l.fx.location)));
  });

  it("is the judge the line's S6 station is registered with", () => {
    const source = readFileSync(new URL("../../src/judge/stations.ts", import.meta.url), "utf8");
    expect(source).toContain("s6Station(");
    expect(source).toContain("containerTestJudge(");
  });
});
