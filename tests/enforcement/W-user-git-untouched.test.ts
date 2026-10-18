// covers: S11.2.never-merges
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as userRepo from "../../src/git/user-repo.js";
import { attemptImport, importCandidate, importCode } from "../helpers/candidate-import.js";
import { bundleOf, diffSnapshots, makeCandidateWorld, snapshotDir, snapshotGitDir } from "../helpers/git-fixture.js";
import { put, realTempDir } from "../helpers/ops-fixture.js";
import { gitIn } from "../helpers/tmp.js";

const NOTHING = { added: [], changed: [], removed: [] };
const outsideGit = (rel: string): boolean => rel === ".git" || rel.startsWith(".git/");

// Spec §5.4, §7, §11 rule 1: a published candidate adds one ref and its objects to the user's repository, and nothing else.
describe("W-user-git-untouched", () => {
  it("adds exactly one branch and changes nothing else, with traps planted in the repository and a hostile candidate", async () => {
    const root = realTempDir("omf-untouched-");
    const sentinels = join(root, "sentinels");
    mkdirSync(sentinels);
    const trap = join(root, "trap.sh");
    writeFileSync(trap, `#!/bin/sh\necho ran >> "${sentinels}/ran-$$"\nexit 0\n`);
    chmodSync(trap, 0o755);
    const hooksPath = join(root, "hooks");
    mkdirSync(hooksPath);

    const world = makeCandidateWorld({
      workId: "w1",
      work: [{ files: { ".gitattributes": "* filter=evil\n", "src/app.ts": "export const app = 2;\n" } }],
    });
    const gitDir = join(world.userRepo, ".git");
    // The user's repository: a fsmonitor program, a hooks path and a default hook that write a sentinel, reflogs forced on,
    // an uncommitted edit and an untracked file.
    gitIn(world.userRepo, "config", "core.fsmonitor", trap);
    gitIn(world.userRepo, "config", "core.hooksPath", hooksPath);
    gitIn(world.userRepo, "config", "core.logAllRefUpdates", "always");
    for (const dir of [hooksPath, join(gitDir, "hooks")]) {
      copyFileSync(trap, join(dir, "reference-transaction"));
      chmodSync(join(dir, "reference-transaction"), 0o755);
    }
    put(world.userRepo, "README.md", "# edited, not committed\n");
    put(world.userRepo, "untracked.txt", "u\n");

    // A bundle that names `main` next to HEAD is refused, and the refusal touches nothing: not even an object.
    const everything = snapshotGitDir(gitDir, { objects: true });
    const refused = await attemptImport(world, { bundle: bundleOf(world.containerRepo, "HEAD", "main") });
    expect(importCode(refused.result)).toBe("head_missing");
    expect(diffSnapshots(everything, snapshotGitDir(gitDir, { objects: true }))).toEqual(NOTHING);

    const gitBefore = snapshotGitDir(gitDir);
    const treeBefore = snapshotDir(world.userRepo, outsideGit);
    const imported = await importCandidate(world);
    await userRepo.publishBranch({
      repo: world.userRepo,
      quarantine: imported.quarantine,
      workId: "w1",
      head: imported.head,
      knownHeads: [],
      scratchDir: join(root, "publish-scratch"),
    });

    expect(readdirSync(sentinels)).toEqual([]);
    expect(diffSnapshots(gitBefore, snapshotGitDir(gitDir))).toEqual({
      added: ["refs/heads/omf/w1"],
      changed: [],
      removed: [],
    });
    expect(diffSnapshots(treeBefore, snapshotDir(world.userRepo, outsideGit))).toEqual(NOTHING);
    expect(existsSync(join(gitDir, "logs", "refs", "heads", "omf"))).toBe(false);
    expect(gitIn(world.userRepo, "rev-parse", "refs/heads/omf/w1").trim()).toBe(imported.head);
    expect(gitIn(world.userRepo, "symbolic-ref", "HEAD").trim()).toBe("refs/heads/main");
  });
});
