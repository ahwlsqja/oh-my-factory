import { markHostEnded } from "../container/lifecycle.js";
import { stopCause } from "../container/running.js";
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
  /**
   * One fresh, created-and-measured SUT container per scenario session; release removes it. A `null` handle is a container
   * the candidate's own image failed during the probe window (already removed): the session fails its first step without an exec.
   */
  acquire: () => Promise<{ handle: ContainerHandle | null; release: () => Promise<void> }>;
}

/**
 * The SUT half of the scenario port and the only adapter allowed to run candidate code (spec 5.5). A step becomes one
 * `docker exec` whose argv are `[...run, ...step.argv]` and whose stdin is `step.stdin`: data, never a shell string,
 * so no element of a scenario is ever the program. The runner returns an observation and never sees an expectation.
 *
 * Who caused a stop decides how it is reported. A timeout, an output limit and invalid UTF-8 are the candidate's doing, so they
 * come back as `signaled` (which every expectation fails with `not_exited`) and the candidate cannot end the item `blocked` by
 * causing them. A candidate can also end its own container (it can install the `sleep` that is PID 1, or push PID 1 into an OOM
 * kill; see `stopCause`), so a container that is not running after a non-zero exit or an exec client error is attributed by
 * `stopCause`: one the host removed or stopped, or whose lifetime ran out, or whose state the daemon would not tell, is an
 * infrastructure `error` and ends the round as `round_error`; one that stopped early on its own is the candidate's, reported as
 * `signaled` `container_exited`. A non-zero exit from a container that is still running is the candidate's result. An exit with
 * no status (the docker client was killed) is an `error` whatever the container state, because nothing says how the program ended.
 * A timeout kills the docker client, not the process inside the container, so the container is removed at once and nothing keeps
 * running behind the next step. A candidate-installed `sleep` can keep a SUT container alive past its lifetime; the sweep of the
 * next run removes it. The probe that measures the container before its first step is the same window: the probe `sh` and the
 * `sleep` come from the candidate-built image, so a probe that fails, hangs, prints something unreadable or reports a vendor
 * binary or credential, with the container neither removed nor stopped by the host, never reaches the relay as a container;
 * `acquire` hands back a null handle and the first step comes back `signaled` `container_exited`, like a step against a
 * container the candidate ended.
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
      const { handle } = lease;
      let gone = handle === null;
      const stop = async (outcome: StepObservation): Promise<StepObservation> => {
        gone = true;
        if (handle === null) return outcome;
        markHostEnded(handle);
        await runtime.remove(handle);
        return outcome;
      };
      return {
        async runStep(step, limits) {
          if (gone || handle === null) return { outcome: "signaled", signal: "container_exited" };
          const result = await runtime.exec(handle, {
            argv: [...input.run, ...step.argv],
            stdin: step.stdin,
            workdir: SCRATCH,
            env: STEP_ENV,
            timeoutMs: limits.timeoutMs,
            maxOutputBytes: limits.maxOutputBytes,
          });
          if (result.kind === "timeout" || result.kind === "output_limit")
            return stop({ outcome: "signaled", signal: result.kind });
          if (result.kind === "exited" && result.status === null) return stop({ outcome: "error" });
          const status = result.kind === "exited" ? (result.status ?? 0) : 0;
          if (result.kind === "error" || status !== 0) {
            const { cause } = await stopCause(runtime, handle);
            // Only a container that still runs leaves a non-zero exit to the candidate; one it ended itself is its failure.
            if (cause === "candidate") return stop({ outcome: "signaled", signal: "container_exited" });
            if (cause === "host" || cause === "unknown") return stop({ outcome: "error" });
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
