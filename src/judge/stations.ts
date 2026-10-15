import type { ContainerRuntime } from "../container/runtime.js";
import type { ProjectLocation } from "../core/paths.js";
import type { Station } from "../work/sequencer.js";
import type { CandidateSource } from "./candidate.js";
import { type JudgeEngine, realEngine, releaseHeld } from "./engine.js";
import { withEntryCheck } from "./entry-check.js";
import { type FeedbackSlot, RoundHolder } from "./round-state.js";
import { s4Station } from "./s4-station.js";

export interface JudgeLineDeps {
  location: ProjectLocation;
  runtime: ContainerRuntime;
  candidates: CandidateSource;
  feedback: FeedbackSlot;
  now?: () => Date;
  /** Default `<item>/runs/<run_id>/judge`. */
  stageRoot?: (itemDir: string, runId: string) => string;
  gateTimeoutMs?: number;
  /** The container side of a round; the default is the real one. The tests of the stations pass a double. */
  engine?: JudgeEngine;
}

/** The deps with the engine chosen, which is what the stations are built over. */
export type ResolvedDeps = JudgeLineDeps & { engine: JudgeEngine };

export interface JudgeStations {
  S4: Station;
  /** Wraps the S2 station with the test-split entry check. */
  withEntryCheck(s2: Station): Station;
  /** Passed to `runLine` as `onLineEnd`: removes the round images this line still owns. Idempotent. */
  dispose(): Promise<void>;
}

/** The judge stations of one line, sharing one `RoundHolder`. */
export function judgeStations(deps: JudgeLineDeps): JudgeStations {
  const resolved: ResolvedDeps = { ...deps, engine: deps.engine ?? realEngine() };
  const holder = new RoundHolder();
  return {
    S4: s4Station(resolved, holder),
    withEntryCheck: (s2) => withEntryCheck(s2, resolved),
    dispose: () => releaseHeld(resolved.runtime, resolved.engine, holder),
  };
}
