import { endedByHost, lifetimeElapsed } from "./lifecycle.js";
import type { ContainerHandle, ContainerRuntime } from "./runtime.js";

/** What the daemon says about a container: running, gone (known and not running), or unknown (the daemon did not say). */
export type ContainerState = "running" | "gone" | "unknown";

/** What the daemon reports about a container that stopped; every field is null when the document does not carry it. */
export interface StoppedEvidence {
  oom_killed: boolean | null;
  exit_code: number | null;
  finished_at: string | null;
}

interface Read {
  state: ContainerState;
  evidence: StoppedEvidence | null;
}

const NO_ANSWER: Read = { state: "unknown", evidence: null };

async function readState(runtime: Pick<ContainerRuntime, "inspect">, handle: ContainerHandle): Promise<Read> {
  try {
    const answer = await runtime.inspect(handle);
    const doc = Array.isArray(answer) ? answer[0] : answer;
    const state = (doc as { State?: Record<string, unknown> } | null | undefined)?.State;
    const running = state?.Running;
    if (running === true) return { state: "running", evidence: null };
    if (running !== false) return NO_ANSWER;
    return {
      state: "gone",
      evidence: {
        oom_killed: typeof state?.OOMKilled === "boolean" ? state.OOMKilled : null,
        exit_code: typeof state?.ExitCode === "number" ? state.ExitCode : null,
        finished_at: typeof state?.FinishedAt === "string" ? state.FinishedAt : null,
      },
    };
  } catch {
    return NO_ANSWER;
  }
}

/**
 * The state of a container by `inspect`. `docker inspect` prints an array of one document, which the real runtime hands back
 * as is; a test double may hand back the document itself. Only a boolean `State.Running` answers: true is `running`, false is
 * `gone`. A failed inspect, an empty answer and a missing or non-boolean field are `unknown`, never `gone`, so a daemon that
 * cannot answer is never read as a container that went away.
 */
export async function containerState(
  runtime: Pick<ContainerRuntime, "inspect">,
  handle: ContainerHandle,
): Promise<ContainerState> {
  return (await readState(runtime, handle)).state;
}

/**
 * Who ended a container that is not running:
 * - `running`: it still runs; a non-zero exit or an exec client error is the program's or the client's, not the container's.
 * - `host`: the host removed or stopped it, or its lifetime ran out. Infrastructure, never a candidate or gate result.
 * - `candidate`: it stopped early on its own (it was killed by the memory limit, or something in it ended PID 1), before the
 *   host touched it and before its lifetime was up.
 * - `unknown`: the daemon did not say (a failed inspect, which is also what a container the host removed answers), or no start
 *   was recorded so the elapsed lifetime cannot be told. Infrastructure, because nothing proves the candidate did it.
 */
export type StopCause = "running" | "host" | "candidate" | "unknown";

export interface StopDecision {
  cause: StopCause;
  /** What the daemon reported about the stop (`State.OOMKilled`, `State.ExitCode`, `State.FinishedAt`); null unless it stopped. */
  evidence: StoppedEvidence | null;
}

/**
 * A candidate CAN end its own container. The SUT runs from a round image whose build ran candidate code as root, and
 * `--entrypoint sleep` is looked up through the image PATH, so the candidate can install its own `sleep`; PID 1 runs as the same
 * uid as the candidate and is dumpable, so the candidate can raise `/proc/1/oom_score_adj` and then exceed the memory limit;
 * and a daemon configured with `init: true` makes PID 1 docker-init with `sleep` as a killable child. So a container that is gone is not infrastructure by default: the host decides by what it
 * knows. It removed or stopped the container itself, or the container's lifetime had elapsed on the host clock (measured from
 * the start recorded when `docker start` returned, less `LIFETIME_SLACK_MS`), then it is the host's; otherwise it stopped early on
 * its own and that is the candidate's doing, OOM kill included.
 */
export async function stopCause(
  runtime: Pick<ContainerRuntime, "inspect">,
  handle: ContainerHandle,
): Promise<StopDecision> {
  const { state, evidence } = await readState(runtime, handle);
  if (state === "running") return { cause: "running", evidence: null };
  if (state === "unknown") return { cause: "unknown", evidence: null };
  if (endedByHost(handle)) return { cause: "host", evidence };
  const elapsed = lifetimeElapsed(handle);
  if (elapsed === null) return { cause: "unknown", evidence };
  return { cause: elapsed ? "host" : "candidate", evidence };
}
