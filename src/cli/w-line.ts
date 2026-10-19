import { standingSealStation } from "../author/station.js";
import type { ContainerRuntime } from "../container/runtime.js";
import { readConfig } from "../core/config.js";
import type { ProjectLocation } from "../core/paths.js";
import { resolveRoles } from "../core/roles.js";
import { combineLineEnd, implementerStations } from "../implementer/station.js";
import { createFeedbackSlot } from "../judge/round-state.js";
import { sweepImplementerContainers, sweepOrphans } from "../judge/state.js";
import { judgeStations } from "../judge/stations.js";
import type { StationId } from "../work/line-types.js";
import type { LineResult, Station } from "../work/sequencer.js";
import { EXIT, type ExitCode } from "./exit.js";

/** The stations of one line and the one cleanup the sequencer calls when the line ends (`LineOptions.onLineEnd`). */
export interface LineAssembly {
  stations: Record<StationId, Station>;
  onLineEnd: () => Promise<void>;
}

/** S7 has no work of its own in v0.1: the sequencer's bookkeeping around it is the whole station. */
const alwaysOk = (id: "S7"): Station => ({ id, run: () => ({ kind: "ok" }) });

/**
 * What `omf run` cleans up in the daemon, for this item only. At the start of the line (S1, under the item claim) every
 * container an earlier run or seal pass left behind goes (`sweepOrphans`: the judge roles, the implementer and the author,
 * the author only while no `omf seal` holds `seal.lock`), whatever station the line then stops at. At the end of the line,
 * finished, vetoed or stopped, any implementer container of the item still there goes too. Both are best effort: a daemon
 * that cannot answer never changes what the line returns.
 */
function containerSweeps(runtime: ContainerRuntime): {
  start: Station;
  end: () => Promise<void>;
} {
  let seen: { itemDir: string; runId: string } | null = null;
  return {
    start: {
      id: "S1",
      async run(ctx) {
        seen = { itemDir: ctx.item.dir, runId: ctx.runId };
        try {
          await sweepOrphans({ runtime, itemDir: ctx.item.dir, currentRunId: ctx.runId, workId: ctx.workId });
        } catch {
          // the next run sweeps again
        }
        return { kind: "ok" };
      },
    },
    async end() {
      if (seen === null) return;
      try {
        await sweepImplementerContainers({ runtime, itemDir: seen.itemDir, currentRunId: seen.runId });
      } catch {
        // the next run's start sweeps what is left
      }
    },
  };
}

/**
 * The seven stations of `omf run` (spec §5.0). S2 is the standing-seal station wrapped with the test-split entry check:
 * `omf seal` owns the author, so this line never builds an author session and never needs the author key.
 * S3 is the implementer container, S4 to S6 the judge. One feedback slot connects S6 to the next round's S3, and the
 * implementer's candidate source feeds the judge. The key is read from `env` by the implementer station and nowhere else.
 */
export function assembleLine(input: {
  location: ProjectLocation;
  runtime: ContainerRuntime;
  env: NodeJS.ProcessEnv;
  now?: () => Date;
}): LineAssembly {
  const { location, runtime, env } = input;
  const clock = input.now === undefined ? {} : { now: input.now };
  const feedback = createFeedbackSlot();
  const implementer = implementerStations({ location, runtime, feedback, env, ...clock });
  const judge = judgeStations({ location, runtime, candidates: implementer.candidates, feedback, ...clock });
  const sweeps = containerSweeps(runtime);
  return {
    stations: {
      S1: sweeps.start,
      S2: judge.withEntryCheck(standingSealStation(location)),
      S3: implementer.S3,
      S4: judge.S4,
      S5: judge.S5,
      S6: judge.S6,
      S7: alwaysOk("S7"),
    },
    onLineEnd: combineLineEnd(() => judge.dispose(), implementer.dispose, sweeps.end),
  };
}

/**
 * The exit code of `omf run` for a line result: 0 success, 1 flawed (a problem found in the result), 3 blocked or
 * manual on a person (handoff route J2, J3, J4, J6 or J8), 2 for the environment (J7), for an aborted line and for a
 * blocked result with no handoff, which cannot happen and fails closed.
 */
export function exitForLine(result: LineResult): ExitCode {
  if (result.kind === "aborted") return EXIT.cannotRun;
  if (result.outcome === "success") return EXIT.ok;
  if (result.outcome === "flawed") return EXIT.problem;
  const route = result.handoff?.decision_required.j;
  return route === undefined || route === "J7" ? EXIT.cannotRun : EXIT.waiting;
}

/**
 * The line `omf run` and `omf report` print about the judge. `resolveRoles` reads and validates the `roles.judge`
 * entry; the judge is deterministic until a model judge exists, and nothing here starts one.
 */
export function judgeLine(location: ProjectLocation): string {
  const { judge } = resolveRoles(readConfig(location.dir));
  return `judge: ${judge.kind} checks only (model judge not available)`;
}
