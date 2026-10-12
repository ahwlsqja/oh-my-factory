import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changedPathsSince, headCommit, matchWatched, workingTreeFingerprint } from "../../src/goal/git.js";
import { commitAll, makeGitRepo } from "../helpers/tmp.js";

describe("git helpers", () => {
  it("lists committed, unstaged and untracked changes since a commit", () => {
    const repo = makeGitRepo();
    const base = headCommit(repo);
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    mkdirSync(join(repo, "src", "telemetry"), { recursive: true });
    writeFileSync(join(repo, "src", "telemetry", "a.ts"), "export {};\n");
    commitAll(repo, "add telemetry");
    writeFileSync(join(repo, "README.md"), "# changed\n");
    writeFileSync(join(repo, "new.txt"), "untracked\n");
    expect(changedPathsSince(repo, base)).toEqual(["README.md", "new.txt", "src/telemetry/a.ts"]);
  });

  it("fails for a commit that is not in the repository", () => {
    expect(() => changedPathsSince(makeGitRepo(), "0".repeat(40))).toThrow(/git diff .* failed/);
  });

  it("matches watched globs, including dot paths", () => {
    const paths = ["src/telemetry/a.ts", "src/app.ts", ".github/workflows/ci.yml"];
    expect(matchWatched(paths, ["src/telemetry/**", ".github/**"])).toEqual(["src/telemetry/a.ts", ".github/workflows/ci.yml"]);
    expect(matchWatched(paths, [])).toEqual([]);
  });

  it("fingerprints the commit plus uncommitted state", () => {
    const repo = makeGitRepo();
    const clean = workingTreeFingerprint(repo);
    writeFileSync(join(repo, "README.md"), "# dirty\n");
    expect(workingTreeFingerprint(repo)).not.toBe(clean);
    writeFileSync(join(repo, "README.md"), "# fixture\n");
    expect(workingTreeFingerprint(repo)).toBe(clean);
  });
});
