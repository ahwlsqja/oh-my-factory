import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectDir } from "../../src/core/paths.js";
import { initProject } from "../../src/core/project.js";
import { omf } from "../helpers/cli.js";
import { makeGitRepo, makeTempDir } from "../helpers/tmp.js";

/** A project whose first ledger line has one key renamed, so the event lacks its `seq` field. */
function projectWithMissingSeq(): { repo: string; home: string; ledger: string } {
  const repo = makeGitRepo();
  const home = makeTempDir("omf-home-");
  const env = { HOME: home };
  initProject(repo, env);
  const ledger = join(projectDir(repo, env), "ledger.jsonl");
  writeFileSync(ledger, readFileSync(ledger, "utf8").replace('"seq":', '"sec":'));
  return { repo, home, ledger };
}

describe("a ledger event that lacks a field", () => {
  it("never prints the word undefined and names the missing field", () => {
    const { repo, home } = projectWithMissingSeq();
    const verify = omf(["ledger", "verify"], repo, home);
    expect(verify.code).toBe(1);
    expect(`${verify.stdout}${verify.stderr}`).not.toContain("undefined");
    expect(verify.stderr.split("\n")[0]).toBe("corrupt at seq 1: line 1 has no seq");
    const doctor = omf(["doctor", "--json"], repo, home);
    expect(doctor.stdout).not.toContain("undefined");
    expect(doctor.stdout).toContain("ledger corrupt at seq 1: line 1 has no seq");
  });

  it("puts the path, the line and the next action on stderr line 2", () => {
    const { repo, home, ledger } = projectWithMissingSeq();
    const lines = omf(["ledger", "verify"], repo, home).stderr.split("\n");
    expect(lines[1]).toContain(ledger);
    expect(lines[1]).toContain("line 1");
    expect(lines[1]).toContain("do not edit");
    expect(lines[1]).toContain("omf ledger verify --json");
  });

  it("gives the same information as structured --json fields", () => {
    const { repo, home, ledger } = projectWithMissingSeq();
    const out = omf(["ledger", "verify", "--json"], repo, home);
    expect(out.code).toBe(1);
    expect(JSON.parse(out.stdout)).toEqual({
      ok: false,
      seq: 1,
      reason: "line 1 has no seq",
      line: 1,
      path: ledger,
      next_action: "do not edit the ledger; restore it from a backup",
    });
  });

  it("also adds the second line when another command refuses the ledger", () => {
    const { repo, home, ledger } = projectWithMissingSeq();
    const out = omf(["goal", "status", "g"], repo, home);
    expect(out.code).toBe(2);
    expect(out.stderr.split("\n")[0]).toBe("ledger corrupt at seq 1: line 1 has no seq");
    expect(out.stderr.split("\n")[1]).toContain(ledger);
  });
});

describe("ledger verify --json", () => {
  it("prints the count and head of a sound ledger with the path", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    omf(["init"], repo, home);
    const out = omf(["ledger", "verify", "--json"], repo, home);
    expect(out.code).toBe(0);
    const report = JSON.parse(out.stdout) as { ok: boolean; count: number; head: string; path: string };
    expect(report).toMatchObject({ ok: true, count: 1 });
    expect(report.head).toMatch(/^[0-9a-f]{64}$/);
    expect(report.path.endsWith("ledger.jsonl")).toBe(true);
  });

  it("exits 2 with an error object before init", () => {
    const out = omf(["ledger", "verify", "--json"], makeGitRepo(), makeTempDir("omf-home-"));
    expect(out.code).toBe(2);
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: false, error: "project not initialized; run omf init" });
  });
});

describe("outside a git repository", () => {
  it("says how to fix it, on a second line", () => {
    for (const args of [["init"], ["doctor"], ["ledger", "verify"], ["goal", "status", "g"]]) {
      const out = omf(args, makeTempDir(), makeTempDir("omf-home-"));
      const lines = out.stderr.split("\n");
      if (args[0] === "doctor") {
        expect(out.stdout).toContain("not inside a git repository");
        expect(out.stdout).toContain("git init");
        continue;
      }
      expect(out.code, args.join(" ")).toBe(2);
      expect(lines[0]).toMatch(/^not a git repository: /);
      expect(lines[1]).toContain("git init");
    }
  });
});
