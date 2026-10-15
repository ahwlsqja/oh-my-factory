import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../../src/core/doctor.js";
import { makeTempDir } from "./tmp.js";

// Offline tests must never reach a real Docker daemon, whatever is installed on the machine that runs them.
// tests/global-setup.ts puts tests/helpers/bin-shims first on PATH, next to the claude and codex shims.
describe("the global docker shim", () => {
  it("ships in the bin-shims directory", () => {
    expect(existsSync(new URL("./bin-shims/docker", import.meta.url))).toBe(true);
  });

  it("is the docker every offline test resolves: info fails like a stopped daemon, every other verb exits 1", () => {
    const info = spawnSync("docker", ["--context", "anything", "info"], { encoding: "utf8" });
    expect(info.status).toBe(1);
    expect(info.stderr).toContain("Cannot connect to the Docker daemon");
    const create = spawnSync("docker", ["create", "x"], { encoding: "utf8" });
    expect(create.status).toBe(1);
    expect(create.stderr).toContain("not available in offline tests");
  });

  it("lets a doctor run see a docker binary with no reachable daemon, without any real call", () => {
    const home = makeTempDir("omf-home-");
    const report = runDoctor(makeTempDir(), { ...process.env, HOME: home, OMF_HOME: join(home, ".omf") });
    expect(report.tools.docker).toMatchObject({ found: true, daemon: false });
    expect(report.warnings).toContain("docker daemon is not reachable");
  });
});
