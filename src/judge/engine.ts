import { forbiddenPaths } from "../container/golden.js";
import type { ContainerRuntime } from "../container/runtime.js";
import type { ProjectLocation } from "../core/paths.js";
import type { RoundHolder } from "./round-state.js";
import { buildRoundImages, disposeImages, runJudgeRound } from "./round.js";

/**
 * The container side of a judge round as functions. The default is the real round; the tests of the stations pass a
 * double, so what a station reads, writes and stops on is tested without a container.
 */
export interface JudgeEngine {
  buildRoundImages: typeof buildRoundImages;
  runJudgeRound: typeof runJudgeRound;
  disposeImages: typeof disposeImages;
  forbiddenPaths(location: ProjectLocation): string[];
}

export function realEngine(): JudgeEngine {
  return {
    buildRoundImages,
    runJudgeRound,
    disposeImages,
    forbiddenPaths: (location) => forbiddenPaths(location, process.env),
  };
}

/**
 * Removes every image lease still held and forgets the round state. Idempotent. One failure never stops the others or
 * surfaces from here (this runs in the line's `finally`); what stays behind is swept at the next S4 start.
 */
export async function releaseHeld(runtime: ContainerRuntime, engine: JudgeEngine, holder: RoundHolder): Promise<void> {
  holder.clear();
  for (const lease of holder.drain()) {
    try {
      await engine.disposeImages(runtime, lease);
    } catch {
      // The sweep at the next S4 start removes it by the run ids of this item.
    }
  }
}
