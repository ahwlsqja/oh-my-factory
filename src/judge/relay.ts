import { containerState } from "../container/running.js";
import type { ContainerHandle, ContainerRuntime } from "../container/runtime.js";
import { observationOf } from "../scenario/observe.js";
import type { ScenarioRunner, ScenarioSession } from "../scenario/runner.js";
import type { StepObservation } from "../scenario/types.js";

/** The scratch tmpfs of a SUT container: cwd, HOME and TMPDIR of every step of one scenario (step-state model). */
export const SCRATCH = "/scratch";
const STEP_ENV = { HOME: SCRATCH, TMPDIR: SCRATCH, LC_ALL: "C" } as const;

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
 * Who caused a stop decides how it is reported. A timeout, an output limit and invalid UTF-8 are the candidate's doing, so they
 * come back as `signaled` (which every expectation fails with `not_exited`) and the candidate cannot end the item `blocked` by
 * causing them. A container that is not running after a non-zero exit or an exec client error is never the candidate's doing:
 * a candidate cannot end its own container from inside, because PID 1 is the idle sleep, which installs no signal handlers, and
 * the kernel drops signals sent to a namespace init from inside that namespace when it has no handler (SIGKILL and SIGSTOP
 * included), and the candidate has no docker socket. So whatever the status (1, 125 and up, 137) and for an exec client error,
 * a container that is gone, or whose state the daemon would not tell (a failed inspect), is an infrastructure `error`, which
 * ends the round as `round_error`. A non-zero exit from a container that is still running is the candidate's result. A timeout
 * kills the docker client, not the process inside the container, so the container is removed at once and nothing keeps running
 * behind the next step.
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
          if (result.kind === "error" || status !== 0) {
            // Only a container that is still running leaves a non-zero exit to the candidate. Gone or unknown is the host's.
            if ((await containerState(runtime, lease.handle)) !== "running") return stop({ outcome: "error" });
            if (result.kind === "error") return { outcome: "error" };
          }
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
