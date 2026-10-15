import type { ProcessResult } from "../adapters/process-group.js";
import type { StepObservation } from "./types.js";

/**
 * Maps what a process did to the observation a judge sees. Shared by the host fixture runner and the container relay
 * (M3f), so both judge the same facts the same way.
 *
 * `runProcessGroup` decodes stdout lossily, so invalid UTF-8 arrives as U+FFFD. Fail closed: such output is an
 * `error` observation, never evidence about the implementation. A status of null means the group leader ended by a
 * signal; it is never mapped to an exit code.
 */
export function observationOf(result: ProcessResult): StepObservation {
  switch (result.kind) {
    case "timeout":
      return { outcome: "timeout" };
    case "output_limit":
      return { outcome: "output_limit" };
    case "error":
      return { outcome: "error" };
    case "exited":
      if (result.status === null) return { outcome: "signaled", signal: result.signal ?? "unknown" };
      if (result.stdout.includes("�")) return { outcome: "error" };
      return { outcome: "exited", exit_code: result.status, stdout: result.stdout };
  }
}
