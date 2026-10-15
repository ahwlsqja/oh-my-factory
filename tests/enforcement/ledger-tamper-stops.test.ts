import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectDir } from "../../src/core/paths.js";
import { omf } from "../helpers/cli.js";
import { readTree } from "../helpers/tree.js";
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

  it("the loop, work, budget and decide commands refuse a tampered ledger and write nothing", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    expect(omf(["init"], repo, home).code).toBe(0);
    // Commands that name a person read the repo's git identity; set it so they reach the ledger check.
    execFileSync("git", ["config", "user.email", "tester@example.com"], { cwd: repo });

    const commands = [
      ["goal", "tick", "g-x", "--runner", "host"],
      ["goal", "status", "g-x"],
      ["goal", "resume", "g-x"],
      ["goal", "cancel", "g-x"],
      ["work", "list", "g-x"],
      ["work", "show", "w-0123456789ab"],
      ["work", "approve", "w-0123456789ab"],
      ["veto", "w-0123456789ab", "--reason", "no"],
      ["budget", "show", "g-x"],
      ["budget", "declare", "g-x", "rounds", "3"],
      ["budget", "raise", "g-x", "rounds", "1"],
      ["budget", "raise", "g-x", "wall_time", "2h"],
      ["budget", "raise", "w-0123456789ab", "--rounds", "1"],
      ["budget", "raise", "w-0123456789ab", "--usd", "0.5"],
      // The chain is verified before the item or the --file is looked at (T9/T10 check order), so a missing
      // file is never what these report once the ledger is broken.
      ["decide", "add", "w-0123456789ab", "--file", "/nonexistent/entry.json"],
      ["decide", "resolve", "w-0123456789ab", "d-interface", "--file", "/nonexistent/resolution.json"],
      ["decide", "resolve", "w-0123456789ab", "d-interface", "--na", "--file", "/nonexistent/na.json"],
      ["decide", "defer", "w-0123456789ab", "d-interface", "--file", "/nonexistent/deferral.json"],
      ["decide", "lint", "w-0123456789ab"],
      ["decide", "lint", "w-0123456789ab", "--render"],
      ["decide", "show", "w-0123456789ab"],
    ];

    // Control: on an intact ledger the same commands fail for their own reasons (no such goal, no terminal),
    // never with the ledger message, so that message below can only come from the ledger check.
    for (const args of commands) {
      expect(omf(args, repo, home).stderr, args.join(" ")).not.toContain("ledger corrupt");
    }

    const project = projectDir(repo, { HOME: home });
    const file = join(project, "ledger.jsonl");
    const event = JSON.parse(readFileSync(file, "utf8").split("\n")[0] ?? "") as { payload: Record<string, unknown> };
    event.payload.repo = "/somewhere/else";
    const rest = readFileSync(file, "utf8").split("\n").slice(1).join("\n");
    writeFileSync(file, `${JSON.stringify(event)}\n${rest}`);
    const tampered = readFileSync(file, "utf8");
    const filesBefore = [...readTree(project).keys()];

    for (const args of commands) {
      const result = omf(args, repo, home);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.stderr, args.join(" ")).toContain("ledger corrupt at seq 1");
      expect(readFileSync(file, "utf8"), args.join(" ")).toBe(tampered);
      expect([...readTree(project).keys()], `${args.join(" ")} left a new file behind`).toEqual(filesBefore);
    }
  });
});
