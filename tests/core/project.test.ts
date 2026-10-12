import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/core/ledger.js";
import { NotAGitRepoError, projectDir } from "../../src/core/paths.js";
import { DEFAULT_CONFIG, PROJECT_SUBDIRS, initProject } from "../../src/core/project.js";
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
