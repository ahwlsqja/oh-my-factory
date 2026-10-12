import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

export default function setup(): void {
  // Build from scratch, so a file deleted from src/ cannot linger in dist/ and keep a test passing.
  rmSync("dist", { recursive: true, force: true });
  execFileSync(join("node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], { stdio: "inherit" });
}
