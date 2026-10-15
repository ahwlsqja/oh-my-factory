import type { SealFailureCode } from "../scenario/events.js";
import type { StopRoute } from "../scenario/gate2-adapter.js";
import { assertLineSafe, guardRefusal, locationEnv } from "../vault/line-guard.js";
import { type SealDeps, type SealStageResult, runSealStage } from "./seal.js";

export type S2StationDeps = Omit<SealDeps, "preflight"> & { env?: NodeJS.ProcessEnv };

/**
 * What the line does after S2 (M3c-D21): `gate2` when a seal stands (stored now, or reused after a killed
 * run), `retry_s2` for an author-quality failure (the sequencer's visit cap bounds the loop), `stop` with the
 * route that owns the cause: J2 GATE-1 moved, J3 a person must act, J7 the environment is at fault.
 */
export type S2Next =
  | { next: "gate2"; seal: "stored" | "reused"; seal_id: string }
  | { next: "retry_s2"; code: SealFailureCode }
  | { next: "stop"; route: StopRoute; code: string };

/** `stage` is null when the guard refused before the stage ran. */
export interface S2Outcome {
  step: S2Next;
  stage: SealStageResult | null;
}

/** Author faults that retrying cannot fix (a missing command, a timeout, a disk) go to the environment route. */
const ENVIRONMENT_FAILURES: ReadonlySet<SealFailureCode> = new Set(["timeout", "spawn_failed", "misconfigured", "write_failed"]);

function stepOf(stage: SealStageResult): S2Next {
  switch (stage.status) {
    case "stored":
      return { next: "gate2", seal: "stored", seal_id: stage.seal_id };
    case "reused":
      return { next: "gate2", seal: "reused", seal_id: stage.seal.seal_id };
    case "blocked_gate1":
      return { next: "stop", route: "J2", code: "gate1_not_passing" };
    case "blocked_input":
      return { next: "stop", route: "J3", code: stage.code };
    case "refused":
      return stage.reason === "implementation_started"
        ? { next: "stop", route: "J3", code: stage.reason }
        : { next: "stop", route: "J7", code: stage.reason };
    case "failed":
      return ENVIRONMENT_FAILURES.has(stage.code)
        ? { next: "stop", route: "J7", code: stage.code }
        : { next: "retry_s2", code: stage.code };
  }
}

/**
 * The S2 station over `runSealStage`, guarded the way every station is (M3c rule 4, spec §8): the state-tree check
 * and the poka-yoke run first, with an environment taken from the location. A guard refusal is a J7 stop with
 * a closed code and no stage run; any other error is rethrown.
 */
export async function runS2Station(deps: S2StationDeps): Promise<S2Outcome> {
  const env = deps.env ?? locationEnv(deps.location);
  let stage: SealStageResult;
  try {
    stage = await runSealStage({ ...deps, preflight: () => assertLineSafe(deps.location, env) });
  } catch (err) {
    const code = guardRefusal(err);
    if (code === null) throw err;
    return { step: { next: "stop", route: "J7", code }, stage: null };
  }
  return { step: stepOf(stage), stage };
}
