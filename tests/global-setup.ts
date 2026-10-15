import { execFileSync } from "node:child_process";
import { chmodSync, rmSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

/**
 * `claude` and `codex` shims that exit 97. The workers inherit this PATH, so a test that reaches for a
 * real model fails loudly instead of spending money. Tests that need a working CLI put their own stub
 * first on PATH (tests/helpers/agent-stubs.ts). The real-model smoke script runs outside vitest.
 * The `docker` shim does the same for containers: `info` fails like a stopped daemon and every other verb exits 1,
 * so no offline test can reach a real daemon (the gated tests under tests/gated use their own PATH and context).
 */
const SHIM_DIR = resolve("tests", "helpers", "bin-shims");

export default function setup(): void {
  // Build from scratch, so a file deleted from src/ cannot linger in dist/ and keep a test passing.
  rmSync("dist", { recursive: true, force: true });
  execFileSync(join("node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], { stdio: "inherit" });

  for (const tool of ["claude", "codex", "docker"]) chmodSync(join(SHIM_DIR, tool), 0o755);
  const path = process.env.PATH ?? "";
  if (!path.split(delimiter).includes(SHIM_DIR)) {
    process.env.PATH = path === "" ? SHIM_DIR : `${SHIM_DIR}${delimiter}${path}`;
  }
}
