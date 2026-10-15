import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as userRepo from "../../src/git/user-repo.js";
import { importCandidate } from "../helpers/candidate-import.js";
import { diffSnapshots, makeCandidateWorld, snapshotGitDir } from "../helpers/git-fixture.js";
import { realTempDir } from "../helpers/ops-fixture.js";
import { gitIn } from "../helpers/tmp.js";

const REF = "refs/heads/omf/w1";
const NOTHING = { added: [], changed: [], removed: [] };

async function setup(workId = "w1") {
  const world = makeCandidateWorld({
    workId,
    work: [
      { files: { "src/app.ts": "export const app = 2;\n" } },
      { files: { "src/extra.ts": "export const extra = 1;\n" } },
    ],
  });
  const imported = await importCandidate(world);
  const scratchDir = join(realTempDir("omf-publish-"), "scratch");
  const publish = (options: { head?: string; knownHeads?: string[] } = {}): Promise<void> =>
    userRepo.publishBranch({
      repo: world.userRepo,
      quarantine: imported.quarantine,
      workId,
      head: options.head ?? imported.head,
      knownHeads: options.knownHeads ?? [],
      scratchDir,
    });
  return { world, imported, scratchDir, publish, gitDir: join(world.userRepo, ".git") };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof userRepo.UserRepoError ? error.code : "not a UserRepoError";
  }
  return undefined;
}

// Spec §5.4, §7: the one write into the user's repository, and every case where it must not happen.
describe("publishBranch", () => {
  it("publishes the head as the item's branch and leaves the checked-out branch and the scratch space alone", async () => {
    const { world, imported, publish, scratchDir } = await setup();
    await publish();
    expect(gitIn(world.userRepo, "rev-parse", REF).trim()).toBe(imported.head);
    expect(gitIn(world.userRepo, "cat-file", "-t", imported.root).trim()).toBe("commit");
    expect(gitIn(world.userRepo, "symbolic-ref", "HEAD").trim()).toBe("refs/heads/main");
    expect(readdirSync(scratchDir)).toEqual([]);
  });

  it("refuses a branch the item did not publish and changes nothing, objects included", async () => {
    const { world, publish, gitDir } = await setup();
    gitIn(world.userRepo, "branch", "omf/w1", world.baseSha);
    const before = snapshotGitDir(gitDir, { objects: true });
    expect(await codeOf(publish())).toBe("ref_not_ours");
    expect(diffSnapshots(before, snapshotGitDir(gitDir, { objects: true }))).toEqual(NOTHING);
  });

  it("accepts a head that is only known from an intended publish, and refuses the same ref when it is not known", async () => {
    const { world, imported, publish } = await setup();
    const middle = imported.work[0]?.sha;
    if (middle === undefined) throw new Error("the fixture has no work commit");
    await publish({ head: middle });
    expect(await codeOf(publish())).toBe("ref_not_ours");
    expect(gitIn(world.userRepo, "rev-parse", REF).trim()).toBe(middle);
    await publish({ knownHeads: [middle] });
    expect(gitIn(world.userRepo, "rev-parse", REF).trim()).toBe(imported.head);
  });

  it("refuses to move a branch that is checked out in the main work tree, even when its value is known", async () => {
    const { world, publish, gitDir } = await setup();
    gitIn(world.userRepo, "checkout", "-q", "-b", "omf/w1");
    const before = snapshotGitDir(gitDir, { objects: true });
    expect(await codeOf(publish({ knownHeads: [world.baseSha] }))).toBe("ref_checked_out");
    expect(diffSnapshots(before, snapshotGitDir(gitDir, { objects: true }))).toEqual(NOTHING);
  });

  it("refuses to move a branch that is checked out in a linked work tree", async () => {
    const { world, publish, gitDir } = await setup();
    gitIn(world.userRepo, "worktree", "add", "-q", "-b", "omf/w1", join(realTempDir("omf-linked-"), "wt"));
    const before = snapshotGitDir(gitDir, { objects: true });
    expect(await codeOf(publish({ knownHeads: [world.baseSha] }))).toBe("ref_checked_out");
    expect(diffSnapshots(before, snapshotGitDir(gitDir, { objects: true }))).toEqual(NOTHING);
  });

  it("refuses a work id that is not a valid branch name before writing any object", async () => {
    const { publish, gitDir } = await setup("w1.lock");
    const before = snapshotGitDir(gitDir, { objects: true });
    expect(await codeOf(publish())).toBe("ref_update_failed");
    expect(diffSnapshots(before, snapshotGitDir(gitDir, { objects: true }))).toEqual(NOTHING);
  });
});
