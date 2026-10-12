import { execFileSync } from "node:child_process";
import { join } from "node:path";

export default function setup(): void {
  execFileSync(join("node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], { stdio: "inherit" });
}
