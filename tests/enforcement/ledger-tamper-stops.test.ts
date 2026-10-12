import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectDir } from "../../src/core/paths.js";
import { omf } from "../helpers/cli.js";
import { makeGitRepo, makeTempDir } from "../helpers/tmp.js";

// Spec §8: every command verifies the hash chain before acting; a broken chain stops OMF and the ledger is left as it was.
describe("ledger-tamper-stops", () => {
  it("verify, doctor and init all refuse a tampered ledger and leave it unchanged", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    expect(omf(["init"], repo, home).code).toBe(0);

    const file = join(projectDir(repo, { HOME: home }), "ledger.jsonl");
    const event = JSON.parse(readFileSync(file, "utf8")) as { payload: Record<string, unknown> };
    event.payload.repo = "/somewhere/else";
    writeFileSync(file, `${JSON.stringify(event)}\n`);
    const tampered = readFileSync(file, "utf8");

    const verify = omf(["ledger", "verify"], repo, home);
    expect(verify.code).toBe(1);
    expect(verify.stderr).toContain("corrupt at seq 1: hash mismatch");

    const doctor = omf(["doctor", "--json"], repo, home);
    expect(doctor.code).toBe(1);
    expect(JSON.parse(doctor.stdout).problems).toContain("ledger corrupt at seq 1: hash mismatch");

    const init = omf(["init"], repo, home);
    expect(init.code).toBe(2);
    expect(init.stderr).toContain("ledger corrupt at seq 1: hash mismatch");
    expect(readFileSync(file, "utf8")).toBe(tampered);
  });

  it("the goal and metric commands refuse a tampered ledger and leave it unchanged", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    expect(omf(["init"], repo, home).code).toBe(0);
    // metric propose names the actor from the repo's git identity; set it so the command reaches the ledger check.
    execFileSync("git", ["config", "user.email", "tester@example.com"], { cwd: repo });

    const file = join(projectDir(repo, { HOME: home }), "ledger.jsonl");
    const event = JSON.parse(readFileSync(file, "utf8")) as { payload: Record<string, unknown> };
    event.payload.repo = "/somewhere/else";
    writeFileSync(file, `${JSON.stringify(event)}\n`);
    const tampered = readFileSync(file, "utf8");

    const commands = [
      ["goal", "new", "g-x"],
      ["goal", "audit", "g-x"],
      ["goal", "measure", "g-x", "--runner", "host"],
      ["metric", "propose", "m-x", "--unit", "ms", "--", "sh", "-c", "echo 1"],
    ];
    for (const args of commands) {
      const result = omf(args, repo, home);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.stderr, args.join(" ")).toContain("ledger corrupt at seq 1");
      expect(readFileSync(file, "utf8"), args.join(" ")).toBe(tampered);
    }
  });
});
