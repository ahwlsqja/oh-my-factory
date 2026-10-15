import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as userRepo from "../../src/git/user-repo.js";
import { importCandidate } from "../helpers/candidate-import.js";
import { makeCandidateWorld } from "../helpers/git-fixture.js";
import { realTempDir } from "../helpers/ops-fixture.js";
import { gitIn } from "../helpers/tmp.js";

const race = vi.hoisted(() => ({ before: null as (() => void) | null }));

// Runs `race.before` once, right before the update of the item's branch in the user's repository, to stand in for a second writer.
vi.mock("../../src/git/hardened.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/git/hardened.js")>();
  return {
    ...actual,
    runHostGit: (...call: Parameters<typeof actual.runHostGit>) => {
      const [, args] = call;
      if (race.before !== null && args.includes("update-ref") && args.includes("refs/heads/omf/w1")) {
        const run = race.before;
        race.before = null;
        run();
      }
      return actual.runHostGit(...call);
    },
  };
});

// Spec §5.4: the update names the value it read, so a branch that appears or moves in between is never overwritten.
describe("publishBranch against a concurrent writer", () => {
  it("fails closed when the branch appears between the check and the update, and leaves the other writer's value", async () => {
    const world = makeCandidateWorld({ workId: "w1", work: [{ files: { "src/app.ts": "export const app = 2;\n" } }] });
    const imported = await importCandidate(world);
    race.before = () => {
      gitIn(world.userRepo, "branch", "omf/w1", world.baseSha);
    };
    let code: string | undefined;
    try {
      await userRepo.publishBranch({
        repo: world.userRepo,
        quarantine: imported.quarantine,
        workId: "w1",
        head: imported.head,
        knownHeads: [],
        scratchDir: join(realTempDir("omf-race-"), "scratch"),
      });
    } catch (error) {
      code = error instanceof userRepo.UserRepoError ? error.code : "not a UserRepoError";
    }
    expect(code).toBe("ref_update_failed");
    expect(gitIn(world.userRepo, "rev-parse", "refs/heads/omf/w1").trim()).toBe(world.baseSha);
  });
});
