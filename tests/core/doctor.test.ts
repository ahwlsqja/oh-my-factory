import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../../src/core/doctor.js";
import { initProject } from "../../src/core/project.js";
import { makeGitRepo, makeTempDir } from "../helpers/tmp.js";

const SYSTEM_PATH = "/usr/bin:/bin";

/** A directory of fake CLIs so the test does not depend on what is installed. */
function stubBin(opts: { dockerDaemon: boolean }): string {
  const dir = makeTempDir("omf-bin-");
  const write = (name: string, body: string): void => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };
  write("claude", 'echo "2.1.0 (Claude Code)"');
  write("codex", 'echo "codex-cli 0.160.1"');
  write(
    "docker",
    opts.dockerDaemon
      ? 'if [ "$1" = "info" ]; then echo "29.0.0"; else echo "Docker version 29.0.0"; fi'
      : 'if [ "$1" = "info" ]; then exit 1; else echo "Docker version 29.0.0"; fi',
  );
  return dir;
}

function env(home: string, bin: string | null): NodeJS.ProcessEnv {
  return { HOME: home, OMF_HOME: join(home, ".omf"), PATH: bin ? `${bin}:${SYSTEM_PATH}` : SYSTEM_PATH };
}

describe("runDoctor", () => {
  it("is ok with all tools, a running daemon and an initialized project", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const e = env(home, stubBin({ dockerDaemon: true }));
    initProject(repo, e);
    const report = runDoctor(repo, e);
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.tools.claude).toEqual({ found: true, version: "2.1.0 (Claude Code)" });
    expect(report.tools.docker.daemon).toBe(true);
    expect(report.isolation).toMatchObject({ declared: "L2", measured: "unmeasured" });
  });

  it("writes preflight.json into the project's host directory", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const e = env(home, stubBin({ dockerDaemon: true }));
    const { projectDir } = initProject(repo, e);
    const report = runDoctor(repo, e);
    expect(JSON.parse(readFileSync(join(projectDir, "preflight.json"), "utf8"))).toEqual(report);
  });

  it("reports missing vendor CLIs and an unreachable docker daemon", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const bin = makeTempDir("omf-bin-");
    const docker = join(bin, "docker");
    writeFileSync(docker, '#!/bin/sh\nif [ "$1" = "info" ]; then exit 1; else echo "Docker version 29.0.0"; fi\n');
    chmodSync(docker, 0o755);
    const e = env(home, bin);
    initProject(repo, e);
    const report = runDoctor(repo, e);
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual(
      expect.arrayContaining([
        "claude not found on PATH",
        "codex not found on PATH",
        "docker daemon is not reachable",
      ]),
    );
  });

  it("reports an uninitialized project without writing anything", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const report = runDoctor(repo, env(home, stubBin({ dockerDaemon: true })));
    expect(report.problems).toContain("project not initialized; run omf init");
    expect(report.project.initialized).toBe(false);
  });

  it("reports a corrupt ledger", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const e = env(home, stubBin({ dockerDaemon: true }));
    const { projectDir } = initProject(repo, e);
    writeFileSync(join(projectDir, "ledger.jsonl"), "{not json\n");
    const report = runDoctor(repo, e);
    expect(report.problems).toContain("ledger corrupt at seq 1: unparseable line");
  });

  it("reports when not inside a git repository", () => {
    const home = makeTempDir("omf-home-");
    const report = runDoctor(makeTempDir(), env(home, stubBin({ dockerDaemon: true })));
    expect(report.problems).toContain("not inside a git repository");
    expect(report.repo.is_git_repo).toBe(false);
  });

  it("reports OMF_HOME inside the repository instead of writing there", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const e = { ...env(home, stubBin({ dockerDaemon: true })), OMF_HOME: join(repo, ".omf") };
    const report = runDoctor(repo, e);
    expect(report.problems.some((p) => p.includes("outside the repository"))).toBe(true);
    expect(existsSync(join(repo, ".omf"))).toBe(false);
  });

  it("reports a relative OMF_HOME", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const report = runDoctor(repo, { ...env(home, stubBin({ dockerDaemon: true })), OMF_HOME: "state" });
    expect(report.problems.some((p) => p.includes("must be an absolute path"))).toBe(true);
  });
});
