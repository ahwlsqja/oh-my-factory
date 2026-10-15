import { join } from "node:path";
import type { ContainerRuntime } from "../container/runtime.js";
import { readConfig } from "../core/config.js";
import { Ledger } from "../core/ledger.js";
import type { ProjectLocation } from "../core/paths.js";
import { judgeForbiddenPaths } from "./forbidden.js";
import { runJudgeRound } from "./round.js";
import type { TestJudge } from "./s6-station.js";

/** What the container judge needs from the line; `JudgeLineDeps` satisfies it. */
export interface TestJudgeDeps {
  location: ProjectLocation;
  runtime: ContainerRuntime;
  now?: () => Date;
  stageRoot?: (itemDir: string, runId: string) => string;
}

/**
 * The real `TestJudge`: the test split judged in the two-container judge, in the SUT image S4 built for this round
 * (`state.lease` and `state.run`, so the candidate and its program are the ones the train split saw). Limits and k come from `config.toml` `[judge]`
 * (read per call, so an edit between rounds is seen). A fault throws and S6 maps it to a closed stop.
 */
export function containerTestJudge(deps: TestJudgeDeps): TestJudge {
  return ({ ctx, state, scenarios }) => {
    const now = deps.now ?? ctx.now;
    const stageRoot = deps.stageRoot?.(ctx.item.dir, ctx.runId) ?? join(ctx.item.dir, "runs", ctx.runId, "judge");
    return runJudgeRound({
      runtime: deps.runtime,
      measure: {
        runtime: deps.runtime,
        sink: new Ledger(deps.location.dir, now),
        scope: { goal_id: ctx.goalId, work_id: ctx.workId, run_id: ctx.runId },
        itemDir: ctx.item.dir,
        now,
      },
      config: readConfig(deps.location.dir).judge,
      images: state.lease,
      scenarios,
      phase: "test",
      candidate_sha: state.candidate_sha,
      run: state.run,
      stageRoot,
      forbidden: judgeForbiddenPaths(deps.location),
      round: ctx.round,
      now,
    });
  };
}
