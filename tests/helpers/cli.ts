import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));

/**
 * Variables inherited from the test process that would point the CLI at a real home or repo state:
 * GIT_*, OMF_HOME, the agent config-dir overrides and every XDG_* location.
 */
function isInheritedLocation(key: string): boolean {
  return (
    key.startsWith("GIT_") ||
    key.startsWith("XDG_") ||
    key === "OMF_HOME" ||
    key === "CODEX_HOME" ||
    key === "CLAUDE_CONFIG_DIR"
  );
}

/**
 * Runs the built CLI with HOME pointed at `home`. Inherited locations (see `isInheritedLocation`) are
 * stripped first. `extraEnv` is merged last so a test can set PATH or an agent config dir, but it may
 * not set HOME, OMF_HOME or GIT_*: those are fixed by the harness.
 */
export function omf(
  args: string[],
  cwd: string,
  home: string,
  extraEnv: NodeJS.ProcessEnv = {},
): { code: number; stdout: string; stderr: string } {
  for (const key of Object.keys(extraEnv)) {
    if (key === "HOME" || key === "OMF_HOME" || key.startsWith("GIT_")) {
      throw new Error(`omf(): extraEnv may not set ${key}; the harness fixes it`);
    }
  }
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !isInheritedLocation(key)),
  );
  env.HOME = home;
  Object.assign(env, extraEnv);
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8" });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}
