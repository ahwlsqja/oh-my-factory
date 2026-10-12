import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectDir } from "../../src/core/paths.js";
import { omf } from "../helpers/cli.js";
import { makeGitRepo, makeTempDir } from "../helpers/tmp.js";

const packageVersion = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

describe("omf CLI", () => {
  it("lists its commands", () => {
    const out = omf(["--help"], makeTempDir(), makeTempDir());
    expect(out.code).toBe(0);
    for (const command of ["init", "doctor", "ledger"]) expect(out.stdout).toContain(command);
  });

  it("prints the package version", () => {
    const out = omf(["--version"], makeTempDir(), makeTempDir());
    expect(out.stdout.trim()).toBe(packageVersion);
  });

  it("documents exit codes in help", () => {
    const out = omf(["--help"], makeTempDir(), makeTempDir());
    expect(out.stdout).toContain("Exit codes:");
  });

  it("init creates host state and ledger verify confirms it", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const init = omf(["init"], repo, home);
    expect(init.code).toBe(0);
    expect(init.stdout).toMatch(/^initialized .*\.omf\/projects\/[0-9a-f]{16}\n$/);
    const again = omf(["init"], repo, home);
    expect(again.stdout).toMatch(/^already initialized /);
    const verify = omf(["ledger", "verify"], repo, home);
    expect(verify.code).toBe(0);
    expect(verify.stdout).toMatch(/^ok: 1 events, head [0-9a-f]{64}\n$/);
  });

  it("ledger verify fails before init", () => {
    const out = omf(["ledger", "verify"], makeGitRepo(), makeTempDir("omf-home-"));
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("project not initialized; run omf init");
  });

  it("ledger verify warns about a torn tail but still exits 0", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    omf(["init"], repo, home);
    appendFileSync(join(projectDir(repo, { HOME: home }), "ledger.jsonl"), '{"schema_version":1,"se');
    const out = omf(["ledger", "verify"], repo, home);
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/^ok: 1 events/);
    expect(out.stderr).toContain("torn final line");
  });

  it("ledger verify exits 1 on a corrupt ledger", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    omf(["init"], repo, home);
    writeFileSync(join(projectDir(repo, { HOME: home }), "ledger.jsonl"), "{not json\n");
    const out = omf(["ledger", "verify"], repo, home);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("corrupt at seq 1: unparseable line");
  });

  it("init outside a git repository exits 2 with a clear message", () => {
    const out = omf(["init"], makeTempDir(), makeTempDir("omf-home-"));
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("not a git repository");
  });

  it("doctor --json prints the preflight report", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    omf(["init"], repo, home);
    const out = omf(["doctor", "--json"], repo, home);
    const report = JSON.parse(out.stdout) as { schema_version: number; isolation: { measured: string } };
    expect(report.schema_version).toBe(1);
    expect(report.isolation.measured).toBe("unmeasured");
  });
});
