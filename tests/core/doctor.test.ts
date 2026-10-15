import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type IsolationProbe, runDoctor } from "../../src/core/doctor.js";
import { TORN_TAIL_WARNING } from "../../src/core/ledger.js";
import { projectDir } from "../../src/core/paths.js";
import { initProject } from "../../src/core/project.js";
import { writePollutingAgentStubs } from "../helpers/agent-stubs.js";
import { makeGitRepo, makeTempDir } from "../helpers/tmp.js";

const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

/** Sorted paths of everything under `root` (directories included); empty when `root` is absent. */
function listTree(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true }).map(String).sort();
}

/** Gives a stub directory the real git, so the git probe works while PATH holds nothing else. */
function withGit(dir: string): string {
  symlinkSync(REAL_GIT, join(dir, "git"));
  return dir;
}

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
  return withGit(dir);
}

function env(home: string, bin: string | null): NodeJS.ProcessEnv {
  return { HOME: home, OMF_HOME: join(home, ".omf"), PATH: bin ?? makeTempDir("omf-emptybin-") };
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
    withGit(bin);
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
    expect(existsSync(join(home, ".omf"))).toBe(false);
  });

  it("probes claude and codex without writing into the caller's home", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), '{"hooks":{}}\n');
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "x"\n');
    const bin = makeTempDir("omf-bin-");
    writePollutingAgentStubs(bin);
    withGit(bin);
    // The caller's config-dir overrides point into the watched home, so a probe that only replaced
    // HOME would still leak there. A private TMPDIR keeps the scratch dirs out of shared tmpdir().
    const scratchRoot = makeTempDir("omf-scratch-");
    const e = {
      ...env(home, bin),
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      TMPDIR: scratchRoot,
    };
    const treeBefore = listTree(home);

    const report = runDoctor(repo, e);

    expect(listTree(home)).toEqual(treeBefore);
    expect(readdirSync(scratchRoot)).toEqual([]);
    expect(report.tools.claude).toEqual({ found: true, version: "2.1.0 (Claude Code)" });
    expect(report.tools.codex).toEqual({ found: true, version: "codex-cli 0.160.1" });
    // Each probe ran with a scratch HOME created under the TMPDIR the caller gave.
    const probeHomes = readFileSync(join(bin, "homes.log"), "utf8").trim().split("\n");
    expect(probeHomes).toHaveLength(2);
    for (const probeHome of probeHomes) expect(probeHome.startsWith(`${scratchRoot}/`)).toBe(true);
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

describe("runDoctor: initialized means a verified ledger holding project.initialized", () => {
  it("treats an empty ledger as not initialized and writes no preflight.json", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const e = env(home, stubBin({ dockerDaemon: true }));
    const dir = projectDir(repo, e);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ledger.jsonl"), "");
    const report = runDoctor(repo, e);
    expect(report.project.initialized).toBe(false);
    expect(report.problems).toContain("project not initialized; run omf init");
    expect(existsSync(join(dir, "preflight.json"))).toBe(false);
  });

  it("treats a ledger holding only a torn line as not initialized and writes no preflight.json", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const e = env(home, stubBin({ dockerDaemon: true }));
    const dir = projectDir(repo, e);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ledger.jsonl"), '{"schema_version":1,"se');
    const report = runDoctor(repo, e);
    expect(report.project.initialized).toBe(false);
    expect(report.problems).toContain("project not initialized; run omf init");
    expect(existsSync(join(dir, "preflight.json"))).toBe(false);
  });

  it("warns about a torn tail on an initialized project without failing the report", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const e = env(home, stubBin({ dockerDaemon: true }));
    const dir = projectDir(repo, e);
    initProject(repo, e);
    appendFileSync(join(dir, "ledger.jsonl"), '{"schema_version":1,"se');
    const report = runDoctor(repo, e);
    expect(report.warnings).toContain(TORN_TAIL_WARNING);
    expect(report.ok).toBe(true);
  });
});

describe("runDoctor: advisory isolation and an atomic preflight.json", () => {
  it("reports isolation as advisory and unmeasured by default", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const e = env(home, stubBin({ dockerDaemon: true }));
    const report = runDoctor(repo, e);
    expect(report.isolation).toEqual({
      declared: "L2",
      measured: "unmeasured",
      advisory: true,
      note: expect.any(String),
      failure: null,
    });
    expect(report.isolation.note).toContain("not enforced");
  });

  it("reports an injected probe verbatim and never lets it change ok or problems", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const e = env(home, stubBin({ dockerDaemon: true }));
    initProject(repo, e);
    const baseline = runDoctor(repo, e);
    const seen: unknown[] = [];
    const unreachable: IsolationProbe = (probeEnv, tools) => {
      seen.push(probeEnv.PATH, tools.docker.found);
      return {
        declared: "L2",
        measured: "unmeasurable",
        advisory: true,
        note: "probe note",
        failure: "Cannot connect to the Docker daemon at unix:///x.sock",
      };
    };
    const report = runDoctor(repo, e, undefined, unreachable);
    expect(report.isolation).toEqual({
      declared: "L2",
      measured: "unmeasurable",
      advisory: true,
      note: "probe note",
      failure: "Cannot connect to the Docker daemon at unix:///x.sock",
    });
    expect(seen).toEqual([e.PATH, true]);
    expect([report.ok, report.problems]).toEqual([baseline.ok, baseline.problems]);
    // Even a probe that claims L2 is only a label: the report stays advisory and ok does not move.
    const claimsL2 = runDoctor(repo, e, undefined, () => ({ declared: "L2", measured: "L2", advisory: true, note: "n", failure: null }));
    expect([claimsL2.ok, claimsL2.problems]).toEqual([baseline.ok, baseline.problems]);
    expect(claimsL2.isolation.advisory).toBe(true);
  });

  it("reports a throwing probe as unmeasurable and still writes preflight.json", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const e = env(home, stubBin({ dockerDaemon: true }));
    const { projectDir } = initProject(repo, e);
    const report = runDoctor(repo, e, undefined, () => {
      throw new Error("docker inspect exploded");
    });
    expect(report.isolation).toMatchObject({ declared: "L2", measured: "unmeasurable", advisory: true, failure: "docker inspect exploded" });
    const written = JSON.parse(readFileSync(join(projectDir, "preflight.json"), "utf8")) as { isolation: { measured: string } };
    expect(written.isolation.measured).toBe("unmeasurable");
  });

  it("replaces preflight.json atomically at 0600, also when it existed as 0644, and leaves no temp file", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const e = env(home, stubBin({ dockerDaemon: true }));
    const { projectDir } = initProject(repo, e);
    const path = join(projectDir, "preflight.json");
    writeFileSync(path, "{}\n", { mode: 0o644 });
    chmodSync(path, 0o644);
    const inodeBefore = statSync(path).ino;
    const report = runDoctor(repo, e);
    // A rename puts a new inode in place; an in-place rewrite would keep the old one and expose a truncated file to readers.
    expect(statSync(path).ino).not.toBe(inodeBefore);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(report);
    expect(readdirSync(projectDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
