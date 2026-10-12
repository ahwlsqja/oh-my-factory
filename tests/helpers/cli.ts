import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const CLI = resolve("dist/cli/main.js");

/** Runs the built CLI with HOME pointed at `home` and OMF_HOME unset. */
export function omf(args: string[], cwd: string, home: string): { code: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.OMF_HOME;
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8" });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}
