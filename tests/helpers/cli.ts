import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));

/**
 * Runs the built CLI with HOME pointed at `home`, OMF_HOME unset and no inherited GIT_* variables.
 * `extraEnv` is merged last, so a test can override PATH or anything else.
 */
export function omf(
  args: string[],
  cwd: string,
  home: string,
  extraEnv: NodeJS.ProcessEnv = {},
): { code: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && key !== "OMF_HOME"),
  );
  env.HOME = home;
  Object.assign(env, extraEnv);
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8" });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}
