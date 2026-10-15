import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/core/config.js";
import { Ledger } from "../../src/core/ledger.js";
import { NotAGitRepoError, projectDir, resolveProject } from "../../src/core/paths.js";
import { DEFAULT_CONFIG, PROJECT_SUBDIRS, initProject, projectProblem, readProjectStatus, requireProject } from "../../src/core/project.js";
import { makeGitRepo, makeTempDir } from "../helpers/tmp.js";

describe("initProject", () => {
  it("creates the host layout, default config and the first ledger event", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const result = initProject(repo, { OMF_HOME: join(home, ".omf") });
    expect(result.created).toBe(true);
    for (const sub of PROJECT_SUBDIRS) expect(existsSync(join(result.projectDir, sub))).toBe(true);
    expect(readFileSync(join(result.projectDir, "config.toml"), "utf8")).toBe(DEFAULT_CONFIG);
    const events = new Ledger(result.projectDir).readVerified();
    expect(events.map((e) => e.type)).toEqual(["project.initialized"]);
    expect(events[0]?.payload.repo).toBe(result.repo);
  });

  it("is idempotent", () => {
    const repo = makeGitRepo();
    const env = { OMF_HOME: join(makeTempDir("omf-home-"), ".omf") };
    initProject(repo, env);
    const second = initProject(repo, env);
    expect(second.created).toBe(false);
    expect(new Ledger(second.projectDir).readVerified()).toHaveLength(1);
  });

  it("refuses to run outside a git repository", () => {
    expect(() => initProject(makeTempDir(), { OMF_HOME: makeTempDir() })).toThrow(NotAGitRepoError);
  });

  it("refuses to put OMF state inside the repository", () => {
    const repo = makeGitRepo();
    expect(() => initProject(repo, { OMF_HOME: join(repo, ".omf") })).toThrow(/outside the repository/);
    expect(existsSync(join(repo, ".omf"))).toBe(false);
  });

  it("recovers from a crash that left only a torn first line", () => {
    const repo = makeGitRepo();
    const env = { OMF_HOME: join(makeTempDir("omf-home-"), ".omf") };
    const dir = projectDir(repo, env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ledger.jsonl"), '{"schema_version":1,"se');
    const result = initProject(repo, env);
    expect(result.created).toBe(true);
    expect(new Ledger(dir).readVerified().map((e) => e.type)).toEqual([
      "ledger.tail_discarded",
      "project.initialized",
    ]);
  });

  it("repairs a deleted directory on re-init", () => {
    const repo = makeGitRepo();
    const env = { OMF_HOME: join(makeTempDir("omf-home-"), ".omf") };
    const { projectDir: dir } = initProject(repo, env);
    rmSync(join(dir, "runs"), { recursive: true });
    expect(initProject(repo, env).created).toBe(false);
    expect(existsSync(join(dir, "runs"))).toBe(true);
  });

  it("refuses a corrupt ledger", () => {
    const repo = makeGitRepo();
    const env = { OMF_HOME: join(makeTempDir("omf-home-"), ".omf") };
    const { projectDir: dir } = initProject(repo, env);
    writeFileSync(join(dir, "ledger.jsonl"), "{not json\n");
    expect(() => initProject(repo, env)).toThrow(/ledger corrupt at seq 1/);
  });
});

describe("readProjectStatus", () => {
  const envFor = (): NodeJS.ProcessEnv => ({ OMF_HOME: join(makeTempDir("omf-home-"), ".omf") });

  it("reports no ledger and not initialized when ledger.jsonl does not exist", () => {
    const repo = makeGitRepo();
    const status = readProjectStatus(resolveProject(repo, envFor()));
    expect(status.ledger).toBeNull();
    expect(status.initialized).toBe(false);
  });

  it("reports an empty ledger as ok but not initialized", () => {
    const repo = makeGitRepo();
    const location = resolveProject(repo, envFor());
    mkdirSync(location.dir, { recursive: true });
    writeFileSync(join(location.dir, "ledger.jsonl"), "");
    const status = readProjectStatus(location);
    expect(status.ledger).toEqual({ ok: true, count: 0, head: "0".repeat(64) });
    expect(status.initialized).toBe(false);
  });

  it("reports a ledger holding only a torn line as ok with a torn tail but not initialized", () => {
    const repo = makeGitRepo();
    const location = resolveProject(repo, envFor());
    mkdirSync(location.dir, { recursive: true });
    writeFileSync(join(location.dir, "ledger.jsonl"), '{"schema_version":1,"se');
    const status = readProjectStatus(location);
    expect(status.ledger).toMatchObject({ ok: true, count: 0, tornTail: true });
    expect(status.initialized).toBe(false);
  });

  it("reports an initialized project as initialized", () => {
    const repo = makeGitRepo();
    const env = envFor();
    initProject(repo, env);
    const status = readProjectStatus(resolveProject(repo, env));
    expect(status.ledger).toMatchObject({ ok: true, count: 1 });
    expect(status.initialized).toBe(true);
  });
});

describe("projectProblem and requireProject", () => {
  it("names what keeps a command from using the project", () => {
    const repo = makeGitRepo();
    const env = { OMF_HOME: join(makeTempDir("omf-home-"), ".omf") };
    const location = resolveProject(repo, env);
    expect(projectProblem(readProjectStatus(location))).toBe("project not initialized; run omf init");
    expect(() => requireProject(repo, env)).toThrow("project not initialized; run omf init");
    initProject(repo, env);
    expect(projectProblem(readProjectStatus(location))).toBeNull();
    expect(requireProject(repo, env).initialized).toBe(true);
    writeFileSync(join(location.dir, "ledger.jsonl"), "{}\n");
    expect(projectProblem(readProjectStatus(location))).toMatch(/^ledger corrupt at seq 1: /);
  });
});

describe("the default config.toml text", () => {
  it("writes an active [w] block that parses to the defaults", () => {
    const home = makeTempDir("omf-home-");
    const result = initProject(makeGitRepo(), { OMF_HOME: join(home, ".omf") });
    const text = readFileSync(join(result.projectDir, "config.toml"), "utf8");
    expect(text).toMatch(/^\[w\]$/m);
    expect(parseConfig(text).w).toEqual({ max_rounds: 3, max_model_usd: 5 });
  });
});
