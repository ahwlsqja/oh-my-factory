import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/core/ledger.js";
import { projectDir } from "../../src/core/paths.js";
import { approveGoal } from "../../src/goal/approve.js";
import { goalTemplate } from "../../src/goal/goal-file.js";
import { lockGoal } from "../../src/goal/goal-lock.js";
import { lockFile, proposalFile, readProposal } from "../../src/goal/metrics.js";
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

  it("refuses an image that is a tag, and writes no proposal", () => {
    const { repo, home } = initialized();
    gitIn(repo, "config", "user.email", "dev@example.com");
    const args = (image: string): string[] => [
      "metric",
      "propose",
      "m-p95",
      "--unit",
      "ms",
      "--watch",
      "bench/**",
      "--image",
      image,
      "--",
      "sh",
      "bench/p95.sh",
    ];
    const tag = omf(args("alpine:3.20"), repo, home);
    expect(tag.code).toBe(2);
    expect(tag.stderr).toContain("metric m-p95 image alpine:3.20 is not pinned by digest");
    expect(readProposal(projectDir(repo, { HOME: home }), "m-p95")).toBeNull();
    const pinned = omf(args(`alpine@sha256:${"a".repeat(64)}`), repo, home);
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
  it("keeps template placeholders and short-wall-time advice together without blocking approval", () => {
    const fx = setupGoal();
    const template = goalTemplate("g-fast").replace(/m-replace-me/g, "m-p95");
    writeFileSync(fx.goalFile, template);
    const auditJson = () => JSON.parse(omf(["goal", "audit", "g-fast", "--json"], fx.repo, fx.home).stdout);
    const fresh = auditJson();
    expect(template).toContain("wall_time: 14d");
    expect(fresh).toMatchObject({ state: "draft", problems: [], warnings: [] });
    expect(fresh.placeholders.length).toBeGreaterThan(0);

    writeFileSync(fx.goalFile, template.replace("wall_time: 14d", "wall_time: 72h"));
    const short = auditJson();
    expect(short).toMatchObject({ state: "draft", problems: [], placeholders: fresh.placeholders });
    expect(short.warnings).toHaveLength(1);
    const text = omf(["goal", "audit", "g-fast"], fx.repo, fx.home);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("still template text in goal.md (replace before you approve):");
    expect(text.stdout).toContain("warnings:");
    expect(text.stdout).toContain("wall time 72h is not longer than the minimum observation 7d");

    expect(approveGoal(fx.location, "g-fast", "human:dev").created).toBe(true);
    expect(auditJson()).toMatchObject({
      state: "approved",
      problems: [],
      placeholders: fresh.placeholders,
      warnings: short.warnings,
    });
  });

  it("reports a draft that is ready for J1", () => {
    const fx = setupGoal();
    const result = omf(["goal", "audit", "g-fast"], fx.repo, fx.home);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("goal g-fast: draft");
    expect(result.stdout).toContain("ready for J1: run omf goal approve g-fast");
  });

  it("does not call a draft ready when a stored proposal image is a tag", () => {
    const fx = setupGoal();
    const file = proposalFile(fx.location.dir, "m-p95");
    const stored = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, `${JSON.stringify({ ...stored, image: "alpine:3.20" }, null, 2)}\n`);
    const result = omf(["goal", "audit", "g-fast"], fx.repo, fx.home);
    expect(result.stdout).not.toContain("ready for J1");
    expect(result.stdout).toContain("metric m-p95 image alpine:3.20 is not pinned by digest");
    expect(result.stdout).toContain("propose the metric again with a digest");
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
    expect(audit.stdout).toContain(
      "approving again repairs a changed goal.md or watched path, other problems are listed below",
    );
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

  it("prints the revision, dirty state, directory contract and capture time, and no absolute temp path", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    writeFileSync(join(fx.repo, "scratch.txt"), "x\n");
    const result = omf(["goal", "measure", "g-fast", "--runner", "host"], fx.repo, fx.home);
    expect(result.code).toBe(0);
    const head = gitIn(fx.repo, "rev-parse", "HEAD").trim();
    expect(result.stdout).toContain(`measured at revision ${head.slice(0, 12)} (dirty, 1 changed path), observed `);
    expect(result.stdout).toMatch(/observed \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    expect(result.stdout).toContain("working directory: repository root (host, no isolation)");
    // The `report:` line names the host-state file by design and predates provenance; every other line must be path-free.
    const rest = result.stdout
      .split("\n")
      .filter((line) => !line.startsWith("report: "))
      .join("\n");
    for (const path of [fx.repo, fx.home, tmpdir()]) expect(rest).not.toContain(path);
  });

  it("uses Docker by default and fails metrics that have no image", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    const result = omf(["goal", "measure", "g-fast"], fx.repo, fx.home);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("unmeasured (no_image): metric m-p95 has no image");
  });

  it("prints the target as unmeasured, not as a number, when the target metric has no result", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    const result = omf(["goal", "measure", "g-fast"], fx.repo, fx.home);
    expect(result.stdout).toContain("target m-p95: unmeasured; target <= 250 ms");
    expect(result.stdout).not.toMatch(/target m-p95: \d/);
    expect(result.stdout).not.toContain("; met");
  });

  it("exits 2 for an unapproved goal", () => {
    const fx = setupGoal();
    const result = omf(["goal", "measure", "g-fast", "--runner", "host"], fx.repo, fx.home);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("goal g-fast is not approved (J1); nothing was measured");
  });
});
