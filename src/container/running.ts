import type { ContainerHandle, ContainerRuntime } from "./runtime.js";

/** What the daemon says about a container: running, gone (known and not running), or unknown (the daemon did not say). */
export type ContainerState = "running" | "gone" | "unknown";

/**
 * The state of a container by `inspect`. `docker inspect` prints an array of one document, which the real runtime hands back
 * as is; a test double may hand back the document itself. Only a boolean `State.Running` answers: true is `running`, false is
 * `gone`. A failed inspect, an empty answer and a missing or non-boolean field are `unknown`, never `gone`, so a daemon that
 * cannot answer is never read as a container that went away. Callers treat `gone` and `unknown` alike when a non-zero exit
 * must not become a candidate or gate result.
 */
export async function containerState(
  runtime: Pick<ContainerRuntime, "inspect">,
  handle: ContainerHandle,
): Promise<ContainerState> {
  try {
    const answer = await runtime.inspect(handle);
    const doc = Array.isArray(answer) ? answer[0] : answer;
    const running = (doc as { State?: { Running?: unknown } } | null | undefined)?.State?.Running;
    if (running === true) return "running";
    return running === false ? "gone" : "unknown";
  } catch {
    return "unknown";
  }
}
