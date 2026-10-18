import type { SealFailureCode } from "../scenario/events.js";
import { GATE_ERROR_REASON, type Gate2Outcome, type StopRoute, evaluateGate2Step } from "../scenario/gate2-adapter.js";
import type { ExposureCount, J3SamplingHook } from "../scenario/gate2.js";
import type { ScenarioRunner, StepLimits } from "../scenario/runner.js";
import type { SealFeedback } from "../scenario/types.js";
import { assertLineSafe, guardRefusal, locationEnv } from "../vault/line-guard.js";
import { type SealDeps, type SealStageResult, runSealStage } from "./seal.js";

export type S2StationDeps = Omit<SealDeps, "preflight"> & { env?: NodeJS.ProcessEnv };

/**
 * What the line does after S2: `gate2` when a seal stands (stored now, or reused after a killed
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
const ENVIRONMENT_FAILURES: ReadonlySet<SealFailureCode> = new Set([
  "timeout",
  "spawn_failed",
  "misconfigured",
  "not_golden",
  "container_failed",
  "credential_in_output",
  "write_failed",
]);

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
 * The S2 station over `runSealStage`, guarded the way every station is (spec §11 rule 4, §8): the state-tree check
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

export interface LinePassDeps extends S2StationDeps {
  runner: ScenarioRunner;
  limits?: StepLimits;
  sample?: J3SamplingHook;
  exposureCount?: ExposureCount;
}

/**
 * The result of one pass. `back_to_S2` carries the feedback for the next S2 (decision ids and counts only);
 * `retry_s2` is an author failure; `stop` ends the line at the named route. M3b2's sequencer repeats this
 * unit, owns the visit caps and persists the stops (it is the only caller that loops).
 */
export type LinePass =
  | { status: "pass"; seal: "stored" | "reused"; not_run: string[]; gate2: Gate2Outcome }
  | { status: "back_to_S2"; seal: "stored" | "reused"; feedback: SealFeedback | null; gate2: Gate2Outcome }
  | { status: "retry_s2"; code: SealFailureCode }
  | { status: "stop"; route: StopRoute; code: string };

/**
 * One S2 then GATE-2 pass, guarded at entry and again before each stage (the stage functions run the guard
 * themselves, so a hostile file that appears between S2 and GATE-2 is caught). Nothing here loops and nothing
 * here knows M3b2: it takes a location, a runner and an author, and returns what to do next.
 */
export async function runS2ThenGate2(deps: LinePassDeps): Promise<LinePass> {
  const env = deps.env ?? locationEnv(deps.location);
  try {
    assertLineSafe(deps.location, env);
  } catch (err) {
    const code = guardRefusal(err);
    if (code === null) throw err;
    return { status: "stop", route: "J7", code };
  }
  const s2 = await runS2Station({ ...deps, env });
  const step = s2.step;
  if (step.next === "retry_s2") return { status: "retry_s2", code: step.code };
  if (step.next === "stop") return { status: "stop", route: step.route, code: step.code };
  const gate2 = await evaluateGate2Step({
    ...deps,
    env,
    now: deps.now(),
    preflight: () => assertLineSafe(deps.location, env),
  });
  if (gate2.verdict === "pass") return { status: "pass", seal: step.seal, not_run: gate2.not_run, gate2 };
  if (gate2.next === "back_to_S2") return { status: "back_to_S2", seal: step.seal, feedback: gate2.feedback, gate2 };
  return { status: "stop", route: gate2.stop_route ?? "J7", code: gate2.reasons[0] ?? GATE_ERROR_REASON };
}
