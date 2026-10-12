import { describe, expect, it } from "vitest";
import { omf } from "../helpers/cli.js";
import { makeGitRepo, makeTempDir } from "../helpers/tmp.js";

describe("omf CLI", () => {
  it("lists its commands", () => {
    const out = omf(["--help"], makeTempDir(), makeTempDir());
    expect(out.code).toBe(0);
    for (const command of ["init", "doctor", "ledger"]) expect(out.stdout).toContain(command);
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
