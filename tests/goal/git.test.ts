import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  changedPathsSince,
  commitsSince,
  headCommit,
  matchWatched,
  trackedFiles,
  workingTreeFingerprint,
} from "../../src/goal/git.js";
import { commitAll, gitIn, makeGitRepo } from "../helpers/tmp.js";

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

  it("sees a same-size edit made in the same second as the last index write", () => {
    const repo = makeGitRepo();
    // Write, commit and edit inside one second, then let it pass: git trusts cached stat data for entries
    // older than the index file, so the throwaway index copy has to keep the real index's mtime.
    const top = Math.floor(Date.now() / 1000) + 1;
    while (Date.now() < top * 1000) {
      /* spin to the start of a second */
    }
    writeFileSync(join(repo, "p95.sh"), "echo 312\n");
    commitAll(repo, "add p95");
    const base = headCommit(repo);
    writeFileSync(join(repo, "p95.sh"), "echo 100\n");
    while (Date.now() < (top + 1) * 1000 + 50) {
      /* spin past the second */
    }
    expect(changedPathsSince(repo, base)).toContain("p95.sh");
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

describe("trackedFiles", () => {
  it("lists tracked files sorted and leaves out untracked and ignored ones", () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "my dir"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "export {};\n");
    writeFileSync(join(repo, "my dir", "b.txt"), "b\n");
    writeFileSync(join(repo, ".gitignore"), "ignored.log\n");
    commitAll(repo, "add files");
    writeFileSync(join(repo, "untracked.txt"), "u\n");
    writeFileSync(join(repo, "ignored.log"), "i\n");
    expect(trackedFiles(repo)).toEqual([".gitignore", "README.md", "my dir/b.txt", "src/a.ts"]);
  });
});

describe("commitsSince", () => {
  it("is zero at HEAD and counts later commits", () => {
    const repo = makeGitRepo();
    const base = headCommit(repo);
    expect(commitsSince(repo, base)).toBe(0);
    writeFileSync(join(repo, "a.txt"), "a\n");
    commitAll(repo, "one");
    writeFileSync(join(repo, "b.txt"), "b\n");
    commitAll(repo, "two");
    expect(commitsSince(repo, base)).toBe(2);
  });

  it("counts a merged branch once, as the merge commit", () => {
    const repo = makeGitRepo();
    const base = headCommit(repo);
    gitIn(repo, "switch", "-q", "-c", "side");
    writeFileSync(join(repo, "s1.txt"), "1\n");
    commitAll(repo, "side one");
    writeFileSync(join(repo, "s2.txt"), "2\n");
    commitAll(repo, "side two");
    gitIn(repo, "switch", "-q", "main");
    writeFileSync(join(repo, "m1.txt"), "m\n");
    commitAll(repo, "main one");
    gitIn(
      repo,
      "-c", "user.name=omf-test",
      "-c", "user.email=omf-test@example.invalid",
      "-c", "commit.gpgsign=false",
      "merge", "--no-ff", "-q", "-m", "merge side", "side",
    );
    expect(Number(gitIn(repo, "rev-list", "--count", `${base}..HEAD`).trim())).toBe(4);
    expect(commitsSince(repo, base)).toBe(2);
  });

  it("fails for a commit that is not in the repository", () => {
    expect(() => commitsSince(makeGitRepo(), "0".repeat(40))).toThrow(/git rev-list .* failed/);
  });
});
