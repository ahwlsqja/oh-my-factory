import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/core/ledger.js";
import { projectDir } from "../../src/core/paths.js";
import { lockGoal } from "../../src/goal/goal-lock.js";
import { lockFile, readProposal } from "../../src/goal/metrics.js";
import { omf } from "../helpers/cli.js";
import { setupGoal } from "../helpers/goal.js";
import { gitIn, makeGitRepo, makeTempDir } from "../helpers/tmp.js";

function initialized(): { repo: string; home: string } {
  const repo = makeGitRepo();
  const home = makeTempDir("omf-home-");
  expect(omf(["init"], repo, home).code).toBe(0);
  return { repo, home };
}

describe("omf goal new", () => {
  it("writes goal.md to host state, not to the repository", () => {
    const { repo, home } = initialized();
    const result = omf(["goal", "new", "g-fast"], repo, home);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/created .*goals\/g-fast\/goal\.md/);
    expect(existsSync(join(projectDir(repo, { HOME: home }), "goals", "g-fast", "goal.md"))).toBe(true);
    expect(gitIn(repo, "status", "--porcelain")).toBe("");
  });

  it("refuses to overwrite a goal", () => {
    const { repo, home } = initialized();
    omf(["goal", "new", "g-fast"], repo, home);
    const again = omf(["goal", "new", "g-fast"], repo, home);
    expect(again.code).toBe(2);
    expect(again.stderr).toMatch(/already exists/);
  });

  it("needs an initialized project", () => {
    const result = omf(["goal", "new", "g-fast"], makeGitRepo(), makeTempDir("omf-home-"));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("project not initialized; run omf init");
  });
});

describe("omf metric propose", () => {
  it("records the proposal as the git user", () => {
    const { repo, home } = initialized();
    gitIn(repo, "config", "user.email", "dev@example.com");
    const result = omf(
      ["metric", "propose", "m-p95", "--unit", "ms", "--watch", "bench/**", "--", "sh", "bench/p95.sh"],
      repo,
      home,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("proposed m-p95 as human:dev@example.com");
    expect(readProposal(projectDir(repo, { HOME: home }), "m-p95")).toMatchObject({
      command: ["sh", "bench/p95.sh"],
      unit: "ms",
      watched_paths: ["bench/**"],
      image: null,
      owner: "human:dev@example.com",
    });
  });

  it("warns when no path is watched, because its code can then change without a new approval", () => {
    const { repo, home } = initialized();
    gitIn(repo, "config", "user.email", "dev@example.com");
    const bare = omf(["metric", "propose", "m-p95", "--unit", "ms", "--", "sh", "bench/p95.sh"], repo, home);
    expect(bare.code).toBe(0);
    expect(bare.stderr).toContain("warning: m-p95 watches no path");
    const watched = omf(
      ["metric", "propose", "m-p95", "--unit", "ms", "--watch", "bench/**", "--", "sh", "bench/p95.sh"],
      repo,
      home,
    );
    expect(watched.stderr).not.toContain("warning");
  });

  it("refuses an image that starts with a dash, and writes no proposal", () => {
    const { repo, home } = initialized();
    gitIn(repo, "config", "user.email", "dev@example.com");
    const result = omf(
      ["metric", "propose", "m-p95", "--unit", "ms", "--image=--privileged", "--", "sh", "bench/p95.sh"],
      repo,
      home,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("invalid metric proposal");
    expect(readProposal(projectDir(repo, { HOME: home }), "m-p95")).toBeNull();
  });

  it("warns when the image is a tag, because a tag can be re-pointed after approval", () => {
    const { repo, home } = initialized();
    gitIn(repo, "config", "user.email", "dev@example.com");
    const tag = omf(
      [
        "metric",
        "propose",
        "m-p95",
        "--unit",
        "ms",
        "--watch",
        "bench/**",
        "--image",
        "alpine:3.20",
        "--",
        "sh",
        "bench/p95.sh",
      ],
      repo,
      home,
    );
    expect(tag.code).toBe(0);
    expect(tag.stderr).toContain("warning: m-p95 image alpine:3.20 is not pinned by digest");
    const digest = `alpine@sha256:${"a".repeat(64)}`;
    const pinned = omf(
      [
        "metric",
        "propose",
        "m-p95",
        "--unit",
        "ms",
        "--watch",
        "bench/**",
        "--image",
        digest,
        "--",
        "sh",
        "bench/p95.sh",
      ],
      repo,
      home,
    );
    expect(pinned.code).toBe(0);
    expect(pinned.stderr).toBe("");
  });

  it("refuses when git user.email is not set", () => {
    const { repo, home } = initialized();
    const result = omf(["metric", "propose", "m-p95", "--unit", "ms", "--", "sh", "bench/p95.sh"], repo, home);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/user\.email/);
  });
});

describe("omf goal audit", () => {
  it("reports a draft that is ready for J1", () => {
    const fx = setupGoal();
    const result = omf(["goal", "audit", "g-fast"], fx.repo, fx.home);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("goal g-fast: draft");
    expect(result.stdout).toContain("ready for J1: run omf goal approve g-fast");
  });

  it("exits 1 when the goal needs re-approval", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    writeFileSync(fx.goalFile, readFileSync(fx.goalFile, "utf8").replace("value: 250", "value: 400"));
    const result = omf(["goal", "audit", "g-fast"], fx.repo, fx.home);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("goal g-fast: needs re-approval (regime 1)");
    expect(result.stdout).toContain("- goal.md changed since approval");
  });

  it("reports a tampered lock as tampered, exits 1, and measurement still stops", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    const file = lockFile(fx.location.dir, "g-fast", "m-p95");
    const lock = JSON.parse(readFileSync(file, "utf8")) as { command: string[] };
    lock.command = ["sh", "-c", "echo 1"];
    writeFileSync(file, JSON.stringify(lock));

    const audit = omf(["goal", "audit", "g-fast"], fx.repo, fx.home);
    expect(audit.code).toBe(1);
    expect(audit.stdout).toContain("goal g-fast: tampered (regime 1)");
    expect(audit.stdout).toContain("- metric lock tampered: m-p95");
    expect(audit.stdout).toContain("run omf goal approve g-fast to repair it");
    const json = omf(["goal", "audit", "g-fast", "--json"], fx.repo, fx.home);
    expect((JSON.parse(json.stdout) as { state: string }).state).toBe("tampered");

    const measure = omf(["goal", "measure", "g-fast", "--runner", "host"], fx.repo, fx.home);
    expect(measure.code).toBe(2);
    expect(measure.stderr).toContain("metric lock tampered: m-p95");
  });
});

describe("omf goal approve", () => {
  it("refuses without an interactive terminal and approves nothing", () => {
    const fx = setupGoal();
    gitIn(fx.repo, "config", "user.email", "dev@example.com");
    const result = omf(["goal", "approve", "g-fast"], fx.repo, fx.home);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("J1 approval needs an interactive terminal; nothing was approved");
    expect(new Ledger(fx.location.dir).readVerified().some((e) => e.type === "goal.approved")).toBe(false);
  });

  it("checks for a terminal before it reads the goal, so a missing goal does not change the message", () => {
    const { repo, home } = initialized();
    const result = omf(["goal", "approve", "g-nope"], repo, home);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("J1 approval needs an interactive terminal; nothing was approved");
  });
});

describe("omf goal measure", () => {
  it("prints the gap and warns about the unisolated host runner", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    const result = omf(["goal", "measure", "g-fast", "--runner", "host"], fx.repo, fx.home);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("target m-p95: 312 ms; target <= 250 ms; gap 62 (decrease, medium)");
    expect(result.stdout).toContain("guardrail m-errors: unevaluated");
    expect(result.stderr).toContain("warning: measured on the host without isolation (--runner host)");
  });

  it("uses Docker by default and fails metrics that have no image", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    const result = omf(["goal", "measure", "g-fast"], fx.repo, fx.home);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("failed: metric m-p95 has no image");
  });

  it("exits 2 for an unapproved goal", () => {
    const fx = setupGoal();
    const result = omf(["goal", "measure", "g-fast", "--runner", "host"], fx.repo, fx.home);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("goal g-fast is not approved (J1); nothing was measured");
  });
});
