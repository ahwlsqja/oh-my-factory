import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT, exitFor } from "../../src/cli/exit.js";
import { projectDir } from "../../src/core/paths.js";
import { omf } from "../helpers/cli.js";
import { makeGitRepo, makeTempDir } from "../helpers/tmp.js";

// The contract is the README exit code table and the `Exit codes:` line of `omf --help`:
// 0 ok, 1 a problem was found, 2 the command could not run, 3 blocked on a person.

describe("exit code module", () => {
  it("maps each kind to its documented number", () => {
    expect([exitFor("ok"), exitFor("problem"), exitFor("cannotRun"), exitFor("waiting")]).toEqual([0, 1, 2, 3]);
    expect(Object.keys(EXIT)).toEqual(["ok", "problem", "cannotRun", "waiting"]);
  });

  it("is the table the help text and the README print", () => {
    const help = omf(["--help"], makeTempDir(), makeTempDir("omf-home-")).stdout;
    expect(help).toContain("0 ok, 1 problems found");
    expect(help).toContain("2 the command could not run");
    expect(help).toContain("3 blocked on a person");
  });
});

type Place = "no-git" | "git-uninitialized" | "initialized";

/** PATH with a reachable fake docker in front, so doctor results do not depend on the host's Docker. */
function pathWithDocker(): string {
  const bin = makeTempDir("omf-docker-");
  writeFileSync(
    join(bin, "docker"),
    '#!/bin/sh\nif [ "$1" = "info" ]; then echo 29.0.0; else echo "Docker version 29.0.0"; fi\n',
  );
  chmodSync(join(bin, "docker"), 0o755);
  return `${bin}:${process.env.PATH ?? ""}`;
}

/** Runs `args` in the given place. A fresh repository and home each time, so rows do not influence each other. */
function run(place: Place, args: string[]): number {
  const home = makeTempDir("omf-home-");
  if (place === "no-git") return omf(args, makeTempDir(), home).code;
  const repo = makeGitRepo();
  if (place === "initialized") omf(["init"], repo, home);
  return omf(args, repo, home, args[0] === "doctor" ? { PATH: pathWithDocker() } : undefined).code;
}

// [command, no git repository, git repository not initialized, initialized project with nothing else created]
// "m3" rows are commands of the goal loop; their values are pinned as they are today and carried over to the
// exit code and --json error contract work for those commands.
const COMMANDS: Array<[string[], number, number, number, "own" | "m3"]> = [
  [["init"], 2, 0, 0, "own"],
  [["doctor"], 1, 1, 0, "own"],
  [["ledger", "verify"], 2, 2, 0, "own"],
  [["goal", "new", "g1"], 2, 2, 2, "m3"],
  [["goal", "audit", "g1"], 2, 2, 1, "m3"],
  [["goal", "approve", "g1"], 2, 2, 2, "m3"],
  [["goal", "measure", "g1"], 2, 2, 2, "m3"],
  [["goal", "status", "g1"], 2, 2, 2, "m3"],
  [["goal", "resume", "g1"], 2, 2, 2, "m3"],
  [["goal", "cancel", "g1"], 2, 2, 2, "m3"],
  [["goal", "tick", "g1"], 2, 2, 2, "m3"],
  [["metric", "propose", "m1", "--unit", "ms", "--", "echo", "1"], 2, 2, 2, "m3"],
  [["decide", "add", "w1"], 1, 1, 1, "m3"],
  [["decide", "lint", "w1"], 2, 2, 2, "m3"],
  [["decide", "show", "w1"], 2, 2, 2, "m3"],
  [["decide", "resolve", "w1", "d1"], 1, 1, 1, "m3"],
  [["decide", "defer", "w1", "d1"], 1, 1, 1, "m3"],
  [["work", "list", "g1"], 2, 2, 2, "m3"],
  [["work", "show", "w1"], 2, 2, 2, "m3"],
  [["work", "approve", "w1"], 2, 2, 2, "m3"],
  [["veto", "w1"], 2, 2, 2, "m3"],
  [["budget", "show", "g1"], 2, 2, 2, "m3"],
  [["budget", "declare", "g1", "usd", "5"], 2, 2, 2, "m3"],
  [["budget", "raise", "w1", "--rounds", "4"], 2, 2, 2, "m3"],
];

describe("exit codes of every command", () => {
  it.each(COMMANDS)(
    "%j: no git %i, uninitialized %i, initialized %i (%s)",
    (args, noGit, uninitialized, initialized) => {
      expect(run("no-git", args), "outside a git repository").toBe(noGit);
      expect(run("git-uninitialized", args), "git repository, not initialized").toBe(uninitialized);
      expect(run("initialized", args), "initialized project").toBe(initialized);
    },
    60_000,
  );

  it("a command that could not run outside a repository does so the same way for every command", () => {
    // Usage errors (a missing required option) are exit 1 in commander and are not "could not run".
    const usage = new Set(["decide add", "decide resolve", "decide defer"]);
    for (const [args, noGit] of COMMANDS) {
      if (!usage.has(args.slice(0, 2).join(" "))) expect(noGit, args.join(" ")).toBe(args[0] === "doctor" ? 1 : 2);
    }
  });
});

describe("exit codes of init, doctor and ledger verify by condition", () => {
  it("init: 0 when new and when repeated, 2 outside a repository", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    expect(omf(["init"], repo, home).code).toBe(0);
    expect(omf(["init"], repo, home).code).toBe(0);
    expect(omf(["init"], makeTempDir(), home).code).toBe(2);
  });

  it("doctor: 1 when it finds a problem (finding problems is its job), 0 once the project is initialized", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    const withDocker = { PATH: pathWithDocker() };
    expect(omf(["doctor"], repo, home, withDocker).code).toBe(1);
    omf(["init"], repo, home);
    expect(omf(["doctor"], repo, home, withDocker).code).toBe(0);
  });

  it("doctor: a missing agent CLI is only a warning (0), and --strict makes it a problem (1)", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    omf(["init"], repo, home);
    // An empty PATH directory plus the real git: no docker, no claude, no codex.
    const bin = makeTempDir("omf-bin-");
    const git = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    symlinkSync(git, join(bin, "git"));
    const lenient = omf(["doctor"], repo, home, { PATH: bin });
    expect(lenient.code, lenient.stdout).toBe(0);
    expect(lenient.stderr).toContain("warning: docker not found on PATH");
    expect(lenient.stderr).toContain("fix:");
    const strict = omf(["doctor", "--strict"], repo, home, { PATH: bin });
    expect(strict.code).toBe(1);
    expect(strict.stdout).toContain("claude not found on PATH");
  });

  it("doctor: Docker installed but not running is a warning (0), and --strict makes it a problem (1)", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    omf(["init"], repo, home);
    const bin = makeTempDir("omf-bin-");
    writeFileSync(
      join(bin, "docker"),
      '#!/bin/sh\nif [ "$1" = "info" ]; then exit 1; else echo "Docker version 29.0.0"; fi\n',
    );
    chmodSync(join(bin, "docker"), 0o755);
    symlinkSync(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), join(bin, "git"));
    const lenient = omf(["doctor"], repo, home, { PATH: bin });
    expect(lenient.code, lenient.stdout).toBe(0);
    expect(lenient.stderr).toContain("warning: docker daemon is not reachable (needed for: container judging");
    const strict = omf(["doctor", "--strict"], repo, home, { PATH: bin });
    expect(strict.code).toBe(1);
    expect(strict.stdout).toContain("docker daemon is not reachable");
  });

  it("ledger verify: 0 sound, 0 with a torn tail, 1 corrupt, 2 not initialized", () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-home-");
    expect(omf(["ledger", "verify"], repo, home).code).toBe(2);
    omf(["init"], repo, home);
    const ledger = join(projectDir(repo, { HOME: home }), "ledger.jsonl");
    expect(omf(["ledger", "verify"], repo, home).code).toBe(0);
    appendFileSync(ledger, '{"schema_version":1,"se');
    expect(omf(["ledger", "verify"], repo, home).code).toBe(0);
    writeFileSync(ledger, "{not json\n");
    expect(omf(["ledger", "verify"], repo, home).code).toBe(1);
  });
});
