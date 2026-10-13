import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The script runs the real claude CLI and spends API tokens, so npm test never runs it. These tests only
// pin what can be checked without a model: it parses, it is executable, and it refuses to start without a key.
const SCRIPT = fileURLToPath(new URL("../../scripts/smoke-reconciler.sh", import.meta.url));

describe("scripts/smoke-reconciler.sh", () => {
  it("is valid POSIX sh", () => {
    const result = spawnSync("sh", ["-n", SCRIPT], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("is executable", () => {
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });

  it("refuses to run without ANTHROPIC_API_KEY and runs nothing", () => {
    const result = spawnSync("sh", [SCRIPT], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("ANTHROPIC_API_KEY");
    expect(result.stderr).toContain("Nothing was run");
  });
});
