import { appendFileSync, chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectDir } from "../../src/core/paths.js";
import { omf, omfWithUmask } from "../helpers/cli.js";
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
    expect(verify.stdout).toMatch(/^ok: 1 event, head [0-9a-f]{64}\n$/);
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
    expect(out.stdout).toMatch(/^ok: 1 event,/);
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

describe("omf ledger verify on a ledger that holds no project.initialized", () => {
  it("exits 1 with 'project not initialized' when the initialized ledger was emptied", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    omf(["init"], repo, home);
    writeFileSync(join(projectDir(repo, { HOME: home }), "ledger.jsonl"), "");
    const out = omf(["ledger", "verify"], repo, home);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("project not initialized; run omf init");
  });
});

describe("omf() harness guard", () => {
  it.each([["HOME"], ["OMF_HOME"], ["GIT_DIR"], ["GIT_WORK_TREE"]])("throws when extraEnv sets %s", (key) => {
    expect(() => omf(["--help"], makeTempDir(), makeTempDir(), { [key]: "/x" })).toThrow(
      `omf(): extraEnv may not set ${key}; the harness fixes it`,
    );
  });
});

describe("OMF host state modes", () => {
  const PRIVATE_DIRS = ["", "vault", "vault/metrics", "vault/scenarios", "runs", "worktrees"];
  const PRIVATE_FILES = ["config.toml", "ledger.jsonl"];
  const modeOf = (path: string): string => (statSync(path).mode & 0o777).toString(8);

  /** Asserts that every OMF host directory and file under `dir` has the private mode. */
  function expectPrivate(dir: string): void {
    for (const sub of PRIVATE_DIRS) expect(modeOf(join(dir, sub)), `dir ${sub || "."}`).toBe("700");
    for (const file of PRIVATE_FILES) expect(modeOf(join(dir, file)), file).toBe("600");
  }

  it("init creates the layout at 700 and the files at 600 under a permissive umask", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    expect(omfWithUmask("000", ["init"], repo, home).code).toBe(0);
    expectPrivate(projectDir(repo, { HOME: home }));
  });

  it("init repairs modes that an existing project was left with", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    omfWithUmask("000", ["init"], repo, home);
    const dir = projectDir(repo, { HOME: home });
    chmodSync(dir, 0o755);
    chmodSync(join(dir, "config.toml"), 0o644);
    chmodSync(join(dir, "ledger.jsonl"), 0o644);
    expect(omfWithUmask("000", ["init"], repo, home).stdout).toMatch(/^already initialized /);
    expectPrivate(dir);
  });

  it("doctor writes preflight.json at 600 even when the file already exists at 644", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    omfWithUmask("000", ["init"], repo, home);
    const preflight = join(projectDir(repo, { HOME: home }), "preflight.json");
    writeFileSync(preflight, "{}\n");
    chmodSync(preflight, 0o644);
    omfWithUmask("000", ["doctor"], repo, home);
    expect(modeOf(preflight)).toBe("600");
  });
});
