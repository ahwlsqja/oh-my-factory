import { isRunning } from "../container/running.js";
import type { ContainerHandle, ContainerRuntime } from "../container/runtime.js";
import { observationOf } from "../scenario/observe.js";
import type { ScenarioRunner, ScenarioSession } from "../scenario/runner.js";
import type { StepObservation } from "../scenario/types.js";

/** The scratch tmpfs of a SUT container: cwd, HOME and TMPDIR of every step of one scenario (step-state model). */
export const SCRATCH = "/scratch";
const STEP_ENV = { HOME: SCRATCH, TMPDIR: SCRATCH, LC_ALL: "C" } as const;
/** docker itself reports 125 (daemon error), 126 and 127 (exec failed) and 128+n (signal) in the same channel as the program. */
const SUSPECT_STATUS = 125;

export interface RelayInput {
  runtime: ContainerRuntime;
  /** The contract's `run` argv: the program the candidate exposes. Scenario argv are appended to it, as separate elements. */
  run: readonly string[];
  /** One fresh, created-and-measured SUT container per scenario session; release removes it. */
  acquire: () => Promise<{ handle: ContainerHandle; release: () => Promise<void> }>;
}

/**
 * The SUT half of the scenario port and the only adapter allowed to run candidate code (spec 5.5). A step becomes one
 * `docker exec` whose argv are `[...run, ...step.argv]` and whose stdin is `step.stdin`: data, never a shell string,
 * so no element of a scenario is ever the program. The runner returns an observation and never sees an expectation.
 *
 * Who caused a stop decides how it is reported. A timeout, an output limit, invalid UTF-8 and a container
 * the candidate killed are the candidate's doing, so they come back as `signaled` (which every expectation fails with
 * `not_exited`) and the candidate cannot end the item `blocked` by causing them. Only a runtime fault (the exec client
 * failed while the container is alive) is `error`. A timeout kills the docker client, not the process inside the
 * container, so the container is removed at once and nothing keeps running behind the next step.
 */
export function createContainerScenarioRunner(input: RelayInput): ScenarioRunner {
  if (input.run.length === 0) throw new Error("relay run argv is empty");
  const { runtime } = input;

  return {
    id: "container-relay",
    executes: "candidate",
    async openScenario(target): Promise<ScenarioSession> {
      if (target.kind !== "candidate") {
        return { runStep: async () => ({ outcome: "refused", code: "unknown_fixture" }), close: async () => {} };
      }
      const lease = await input.acquire();
      let gone = false;
      const stop = async (outcome: StepObservation): Promise<StepObservation> => {
        gone = true;
        await runtime.remove(lease.handle);
        return outcome;
      };
      return {
        async runStep(step, limits) {
          if (gone) return { outcome: "signaled", signal: "container_exited" };
          const result = await runtime.exec(lease.handle, {
            argv: [...input.run, ...step.argv],
            stdin: step.stdin,
            workdir: SCRATCH,
            env: STEP_ENV,
            timeoutMs: limits.timeoutMs,
            maxOutputBytes: limits.maxOutputBytes,
          });
          if (result.kind === "timeout" || result.kind === "output_limit")
            return stop({ outcome: "signaled", signal: result.kind });
          const status = result.kind === "exited" ? (result.status ?? 0) : 0;
          const suspect = result.kind === "error" || status !== 0;
          if (suspect && !(await isRunning(runtime, lease.handle))) {
            // A container that went away under a step it was given is the host's doing when docker reports an ordinary
            // failure status (its lifetime ran out: `docker exec` answers 1), so it is a fault, never the candidate's exit.
            // 125 and up, and an exec client failure, stay the candidate's: it is the one that can kill its own container.
            const hostCut = result.kind === "exited" && status < SUSPECT_STATUS;
            return stop(hostCut ? { outcome: "error" } : { outcome: "signaled", signal: "container_exited" });
          }
          if (result.kind === "error") return { outcome: "error" };
          const observation = observationOf(result);
          // observationOf reports undecodable stdout as `error`; from a candidate that is the candidate's own output.
          if (observation.outcome === "error") return { outcome: "signaled", signal: "invalid_utf8" };
          return observation;
        },
        async close() {
          gone = true;
          await lease.release();
        },
      };
    },
  };
}
