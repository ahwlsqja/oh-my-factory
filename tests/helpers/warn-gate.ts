import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { CLI, harnessEnv } from "./cli.js";
import type { CliLine } from "./cli-line.js";
import { makeTempDir } from "./tmp.js";

/**
 * Runs the built CLI so that no `docker` call can start before the parent has seen a given line on stderr. A `docker` program
 * is put first on PATH that waits for a `seen` marker file (at most `waitMs`) and records a violation when the marker never
 * came, then hands the call to the stateful fake daemon. The parent writes the marker when the awaited text appears. A product
 * that prints the line only after it has already spent calls therefore leaves a violation, deterministically and without a race.
 */
export async function runWithWarningBeforeDocker(
  line: CliLine,
  args: string[],
  awaited: string,
  waitMs = 6000,
): Promise<{ code: number; stderr: string; stdout: string; violations: string[] }> {
  const dir = makeTempDir("omf-warn-gate-");
  const seen = join(dir, "seen");
  const violations = join(dir, "violations");
  const real = join(line.bin.dir, "docker");
  writeFileSync(
    join(dir, "docker"),
    [
      "#!/usr/bin/env node",
      'const { existsSync, appendFileSync } = require("node:fs");',
      'const { spawnSync } = require("node:child_process");',
      `const deadline = Date.now() + ${waitMs};`,
      `while (!existsSync(${JSON.stringify(seen)}) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);`,
      `if (!existsSync(${JSON.stringify(seen)})) { appendFileSync(${JSON.stringify(violations)}, process.argv.slice(2).join(" ") + "\\n"); appendFileSync(${JSON.stringify(seen)}, "timeout"); }`,
      `const r = spawnSync(${JSON.stringify(real)}, process.argv.slice(2), { stdio: "inherit" });`,
      "process.exit(r.status ?? 1);",
      "",
    ].join("\n"),
  );
  chmodSync(join(dir, "docker"), 0o755);
  return await new Promise((done, fail) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: line.userRepo,
      env: harnessEnv(line.l.f.fx.home, {
        PATH: `${dir}${delimiter}${line.bin.path}`,
        OMF_IMPLEMENTER_API_KEY: line.key,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => void (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      if (!existsSync(seen) && stderr.includes(awaited)) writeFileSync(seen, "1");
    });
    child.on("error", fail);
    child.on("close", (code) =>
      done({
        code: code ?? -1,
        stdout,
        stderr,
        violations: existsSync(violations) ? readFileSync(violations, "utf8").split("\n").filter(Boolean) : [],
      }),
    );
  });
}
