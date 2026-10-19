import type { ContainerHandle, ContainerRuntime } from "./runtime.js";

/**
 * Whether the daemon says the container is running. `docker inspect` prints an array of one document, which the real runtime
 * hands back as is; a test double may hand back the document itself. A failed inspect, a missing field and a container the
 * daemon no longer knows all read as not running: the answer is only used to tell a vanished container from a live one.
 */
export async function isRunning(runtime: Pick<ContainerRuntime, "inspect">, handle: ContainerHandle): Promise<boolean> {
  try {
    const answer = await runtime.inspect(handle);
    const doc = Array.isArray(answer) ? answer[0] : answer;
    return (doc as { State?: { Running?: unknown } } | null | undefined)?.State?.Running === true;
  } catch {
    return false;
  }
}
