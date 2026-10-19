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
import { type IsolationProbe, runDoctor, runDoctorParallel } from "../../src/core/doctor.js";
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

  it("warns, with the stage that needs the tool, when docker and the agent CLIs are missing", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const bin = makeTempDir("omf-bin-");
    withGit(bin);
    const e = env(home, bin);
    initProject(repo, e);
    const report = runDoctor(repo, e);
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.warnings).toEqual([
      "docker not found on PATH",
      "claude not found on PATH",
      "codex not found on PATH",
    ]);
    const byMessage = Object.fromEntries(report.warning_details.map((w) => [w.message, w]));
    expect(byMessage["docker not found on PATH"]?.needed_by).toEqual([
      "container judging",
      "metric runs in a container",
    ]);
    expect(byMessage["claude not found on PATH"]?.needed_by).toEqual(["the implementer", "the sealing author"]);
    for (const warning of report.warning_details) expect(warning.fix).toMatch(/\S/);
    // The host runner is offered together with its cost.
    expect(byMessage["docker not found on PATH"]?.fix).toContain("--runner host, without isolation");
  });

  it("reports an unreachable docker daemon as a warning that names the stages needing it", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const e = env(home, stubBin({ dockerDaemon: false }));
    initProject(repo, e);
    const report = runDoctor(repo, e);
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.warnings).toEqual(["docker daemon is not reachable"]);
    expect(report.warning_details[0]?.fix).toContain("docker info");
    expect(report.warning_details[0]?.fix).toContain("colima start");
    expect(report.warning_details[0]?.fix).toContain("--runner host, without isolation");
    expect(report.warning_details[0]?.needed_by).toEqual(["container judging", "metric runs in a container"]);
  });

  it("--strict promotes the missing-tool warnings to problems", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const bin = makeTempDir("omf-bin-");
    const docker = join(bin, "docker");
    writeFileSync(docker, '#!/bin/sh\nif [ "$1" = "info" ]; then exit 1; else echo "Docker version 29.0.0"; fi\n');
    chmodSync(docker, 0o755);
    withGit(bin);
    const e = env(home, bin);
    initProject(repo, e);
    const report = runDoctor(repo, e, undefined, undefined, { strict: true });
    expect(report.ok).toBe(false);
    expect(report.strict).toBe(true);
    expect(report.warnings).toEqual([]);
    expect(report.problems).toEqual(
      expect.arrayContaining(["claude not found on PATH", "codex not found on PATH", "docker daemon is not reachable"]),
    );
  });

  it("--strict lists the problems in the order doctor always listed them: tools, then the project", () => {
    const home = makeTempDir("omf-home-");
    const bin = makeTempDir("omf-bin-");
    const docker = join(bin, "docker");
    writeFileSync(docker, '#!/bin/sh\nif [ "$1" = "info" ]; then exit 1; else echo "Docker version 29.0.0"; fi\n');
    chmodSync(docker, 0o755);
    withGit(bin);
    // Docker installed but stopped, no agent CLIs, outside any repository, so a project problem follows the tool ones.
    const stopped = runDoctor(makeTempDir(), env(home, bin), undefined, undefined, { strict: true });
    expect(stopped.problems).toEqual([
      "claude not found on PATH",
      "codex not found on PATH",
      "docker daemon is not reachable",
      "not inside a git repository",
    ]);
    // No docker binary at all: it comes first, before the agent CLIs.
    const bare = makeTempDir("omf-bin-");
    withGit(bare);
    const missing = runDoctor(makeTempDir(), env(home, bare), undefined, undefined, { strict: true });
    expect(missing.problems).toEqual([
      "docker not found on PATH",
      "claude not found on PATH",
      "codex not found on PATH",
      "not inside a git repository",
    ]);
    expect(missing.problem_details.map((p) => p.message)).toEqual(missing.problems);
  });

  it("--strict leaves a torn tail a warning and keeps the exit status ok", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const e = env(home, stubBin({ dockerDaemon: true }));
    const dir = projectDir(repo, e);
    initProject(repo, e);
    appendFileSync(join(dir, "ledger.jsonl"), '{"schema_version":1,"se');
    const report = runDoctor(repo, e, undefined, undefined, { strict: true });
    expect(report.warnings).toContain(TORN_TAIL_WARNING);
    expect(report.problems).not.toContain(TORN_TAIL_WARNING);
    expect(report.ok).toBe(true);
  });

  it("a missing git is still a problem, and every problem has a fix line", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const report = runDoctor(repo, env(home, makeTempDir("omf-emptybin-")));
    expect(report.ok).toBe(false);
    expect(report.problems).toContain("git not found on PATH");
    expect(report.problem_details.map((p) => p.message)).toEqual(report.problems);
    for (const problem of report.problem_details) expect(problem.fix).toMatch(/\S/);
  });

  it("the parallel probes give the same report as the sequential ones", async () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const e = env(home, stubBin({ dockerDaemon: true }));
    initProject(repo, e);
    const fixed = () => new Date(0);
    const sequential = runDoctor(repo, e, fixed);
    const parallel = await runDoctorParallel(repo, e, fixed);
    expect(parallel).toEqual(sequential);
  });

  it("runs the slow probes at the same time", async () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const bin = stubBin({ dockerDaemon: true });
    // Three probes that each take 1 s: one after another they need at least 3 s, together about 1 s.
    for (const name of ["claude", "codex"]) {
      writeFileSync(join(bin, name), `#!/bin/sh\n/bin/sleep 1\necho "${name} 1.0"\n`);
      chmodSync(join(bin, name), 0o755);
    }
    writeFileSync(
      join(bin, "docker"),
      '#!/bin/sh\nif [ "$1" = "info" ]; then /bin/sleep 1; echo 29.0.0; else echo "Docker version 29.0.0"; fi\n',
    );
    const e = env(home, bin);
    const started = Date.now();
    const report = await runDoctorParallel(repo, e);
    const elapsed = Date.now() - started;
    expect(report.tools.claude.found && report.tools.codex.found && report.tools.docker.daemon).toBe(true);
    expect(elapsed).toBeLessThan(2500);
    // The same stubs probed one after another cannot be faster than their sum, which proves the bound above is not trivial.
    const sequentialStarted = Date.now();
    runDoctor(repo, e);
    expect(Date.now() - sequentialStarted).toBeGreaterThanOrEqual(3000);
  }, 20_000);

  it("a probe that hangs is cut off and counts as not found", async () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const bin = stubBin({ dockerDaemon: true });
    const claude = join(bin, "claude");
    writeFileSync(claude, "#!/bin/sh\nexec /bin/sleep 30\n");
    chmodSync(claude, 0o755);
    const started = Date.now();
    const report = await runDoctorParallel(repo, env(home, bin));
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(report.tools.claude.found).toBe(false);
    expect(report.warnings).toContain("claude not found on PATH");
  }, 20_000);

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
    expect(report.problem_details[0]?.fix).toContain("omf ledger verify --json");
  });

  it("tells a planted canary in an ordinary file apart from vault files and never advises moving source", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const e = env(home, stubBin({ dockerDaemon: true }));
    initProject(repo, e);
    // Built at run time: a full canary literal in this file would trip OMF run on OMF.
    writeFileSync(join(repo, "fixture.test.ts"), `const c = "omf-canary-${"ab".repeat(16)}";\n`);
    const report = runDoctor(repo, e);
    const found = report.problem_details.find((p) => p.message.startsWith("sealed material"));
    expect(found?.message).toContain("canary: fixture.test.ts");
    expect(found?.fix).toContain("canary-shaped");
    expect(found?.fix).toContain("at run time");
    expect(found?.fix).not.toMatch(/move the listed vault files/);
    expect(found?.fix).toContain("do not move source or tests into the vault");
    expect(found?.fix).toContain("treat the sealed set as burned");
    expect(found?.fix).toContain("git history");
  });

  it("gives both the vault advice and the canary advice when the findings are mixed", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const e = env(home, stubBin({ dockerDaemon: true }));
    initProject(repo, e);
    writeFileSync(join(repo, "fixture.test.ts"), `const c = "omf-canary-${"ab".repeat(16)}";\n`);
    writeFileSync(join(repo, "goal.lock.json"), "{}\n");
    const found = runDoctor(repo, e).problem_details.find((p) => p.message.startsWith("sealed material"));
    expect(found?.message).toContain("canary: fixture.test.ts");
    expect(found?.fix).toContain("move the listed vault files out of the repository");
    expect(found?.fix).toContain("for a canary finding,");
    expect(found?.fix).toContain("canary-shaped");
    expect(found?.fix).toContain("treat the sealed set as burned");
  });

  it("keeps the move-out advice for real vault files", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const e = env(home, stubBin({ dockerDaemon: true }));
    initProject(repo, e);
    writeFileSync(join(repo, "goal.lock.json"), "{}\n");
    const found = runDoctor(repo, e).problem_details.find((p) => p.message.startsWith("sealed material"));
    expect(found?.fix).toContain("move the listed vault files out of the repository");
    expect(found?.fix).not.toContain("canary-shaped");
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
    const claimsL2 = runDoctor(repo, e, undefined, () => ({
      declared: "L2",
      measured: "L2",
      advisory: true,
      note: "n",
      failure: null,
    }));
    expect([claimsL2.ok, claimsL2.problems]).toEqual([baseline.ok, baseline.problems]);
    expect(claimsL2.isolation.advisory).toBe(true);
  });

  it("hands the probe the project when the config names a codex implementer", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const e = env(home, stubBin({ dockerDaemon: true }));
    initProject(repo, e);
    const file = join(projectDir(repo, e), "config.toml");
    const text = readFileSync(file, "utf8");
    const swapped = text.replace('implementer = { vendor = "claude" }', 'implementer = { vendor = "codex" }');
    expect(swapped).not.toBe(text);
    writeFileSync(file, swapped);
    const vendors: string[] = [];
    const spy: IsolationProbe = (_env, _tools, project) => {
      vendors.push(project === null ? "no project" : project.config.roles.implementer.vendor);
      return { declared: "L2", measured: "unmeasured", advisory: true, note: "n", failure: null };
    };
    runDoctor(repo, e, undefined, spy);
    expect(vendors).toEqual(["codex"]);
  });

  it("hands the probe the project and its config, or null when there is none or config.toml is unreadable", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const e = env(home, stubBin({ dockerDaemon: true }));
    const seen: Array<{ dir: string; k: number } | null> = [];
    const spy: IsolationProbe = (_env, _tools, project) => {
      seen.push(project === null ? null : { dir: project.location.dir, k: project.config.judge.k });
      return { declared: "L2", measured: "unmeasured", advisory: true, note: "n", failure: null };
    };
    runDoctor(repo, e, undefined, spy);
    initProject(repo, e);
    runDoctor(repo, e, undefined, spy);
    writeFileSync(join(projectDir(repo, e), "config.toml"), "[judge");
    const broken = runDoctor(repo, e, undefined, spy);
    expect(seen).toEqual([null, { dir: projectDir(repo, e), k: 3 }, null]);
    expect(broken.isolation.measured).toBe("unmeasured");
  });

  it("reports a throwing probe as unmeasurable and still writes preflight.json", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const e = env(home, stubBin({ dockerDaemon: true }));
    const { projectDir } = initProject(repo, e);
    const report = runDoctor(repo, e, undefined, () => {
      throw new Error("docker inspect exploded");
    });
    expect(report.isolation).toMatchObject({
      declared: "L2",
      measured: "unmeasurable",
      advisory: true,
      failure: "docker inspect exploded",
    });
    const written = JSON.parse(readFileSync(join(projectDir, "preflight.json"), "utf8")) as {
      isolation: { measured: string };
    };
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

describe("runDoctor: implementer readiness advisory", () => {
  const SENTINEL = "sk-ant-doctor-sentinel-0123456789";

  it("names the key variable and whether it is set, never its value, and never moves ok", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const e = env(home, stubBin({ dockerDaemon: true }));
    initProject(repo, e);
    const baseline = runDoctor(repo, e);
    expect(baseline.implementer).toMatchObject({
      advisory: true,
      declared: "L2",
      image_configured: false,
      key_variable: "OMF_IMPLEMENTER_API_KEY",
      key_present: false,
    });
    writeFileSync(join(projectDir(repo, e), "config.toml"), `[implementer]\nimage = "sha256:${"a".repeat(64)}"\n`);
    const ready = runDoctor(repo, { ...e, OMF_IMPLEMENTER_API_KEY: SENTINEL });
    expect(ready.implementer).toMatchObject({ image_configured: true, key_present: true });
    expect(JSON.stringify(ready)).not.toContain(SENTINEL);
    expect(readFileSync(join(projectDir(repo, e), "preflight.json"), "utf8")).not.toContain(SENTINEL);
    expect([ready.ok, ready.problems, ready.warnings]).toEqual([baseline.ok, baseline.problems, baseline.warnings]);
    for (const phrase of ["not enforced", "spend limit", "dedicated docker context", "default bridge"]) {
      expect(ready.implementer.note).toContain(phrase);
    }
  });

  it.each([
    ["empty", ""],
    ["padded with a space", " sk-ant-x "],
    ["over 512 characters", "k".repeat(513)],
  ])("a key that is %s counts as absent, and with no project the image is not configured", (_label, value) => {
    const repo = makeGitRepo();
    const e = env(makeTempDir("omf-home-"), stubBin({ dockerDaemon: true }));
    expect(runDoctor(repo, { ...e, OMF_IMPLEMENTER_API_KEY: value }).implementer).toMatchObject({
      key_present: false,
      image_configured: false,
    });
  });
});

describe("runDoctor: author readiness advisory", () => {
  const SENTINEL = "sk-codex-doctor-sentinel-0123456789";

  it("names the key variable and whether it is set, never its value, and never moves ok", () => {
    const repo = makeGitRepo();
    const e = env(makeTempDir("omf-home-"), stubBin({ dockerDaemon: true }));
    initProject(repo, e);
    const baseline = runDoctor(repo, e);
    expect(baseline.author).toMatchObject({
      advisory: true,
      declared: "L2",
      image_configured: false,
      key_variable: "OMF_AUTHOR_API_KEY",
      key_present: false,
    });
    writeFileSync(join(projectDir(repo, e), "config.toml"), `[author]\nimage = "sha256:${"a".repeat(64)}"\n`);
    const ready = runDoctor(repo, { ...e, OMF_AUTHOR_API_KEY: SENTINEL });
    expect(ready.author).toMatchObject({ image_configured: true, key_present: true });
    expect(JSON.stringify(ready)).not.toContain(SENTINEL);
    expect(readFileSync(join(projectDir(repo, e), "preflight.json"), "utf8")).not.toContain(SENTINEL);
    expect([ready.ok, ready.problems, ready.warnings]).toEqual([baseline.ok, baseline.problems, baseline.warnings]);
    for (const phrase of ["not enforced", "spend limit", "dedicated docker context", "open network"]) {
      expect(ready.author.note).toContain(phrase);
    }
  });

  it("counts only OMF_AUTHOR_API_KEY: another vendor's variable does not make the author ready", () => {
    const repo = makeGitRepo();
    const e = env(makeTempDir("omf-home-"), stubBin({ dockerDaemon: true }));
    const others = { OPENAI_API_KEY: "x", CODEX_API_KEY: "x", OMF_IMPLEMENTER_API_KEY: "x", ANTHROPIC_API_KEY: "x" };
    expect(runDoctor(repo, { ...e, ...others }).author).toMatchObject({ key_present: false, image_configured: false });
    expect(runDoctor(repo, { ...e, OMF_AUTHOR_API_KEY: " padded " }).author.key_present).toBe(false);
  });
});
