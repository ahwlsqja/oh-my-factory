import { runProcessGroup } from "../../src/adapters/process-group.js";
import type { CommandTarget } from "../../src/gate/ports.js";

/**
 * A `CommandTarget` that runs a command in `cwd` on the host, in its own process group, with PATH only. Tests only: the
 * scripts it runs are OMF fixtures. No `src/` module may do this (M3e-D7); M3f supplies the container version.
 */
export function fixtureTarget(cwd: string): CommandTarget {
  return {
    run: (argv, options) =>
      runProcessGroup(argv, {
        cwd,
        env: { PATH: process.env.PATH },
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxOutputBytes,
      }),
  };
}
