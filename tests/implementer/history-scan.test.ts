import { describe, expect, it } from "vitest";
import { readCredential, type Credential } from "../../src/implementer/credential.js";
import { type VaultCanaryIndex, scanCandidateHistory } from "../../src/implementer/history-scan.js";
import { importCandidate } from "../helpers/candidate-import.js";
import { diffSnapshots, makeCandidateWorld, snapshotGitDir } from "../helpers/git-fixture.js";

const KEY = "sk-ant-test-0123456789abcdefghijklmnop";
const NO_CANARIES: VaultCanaryIndex = { index: [], unverified: [], unverified_canaries: [] };
const CAP = 64 * 1024 * 1024;

function credential(): Credential {
  const value = readCredential("claude", { OMF_IMPLEMENTER_API_KEY: KEY });
  if (value === null) throw new Error("the test credential was rejected");
  return value;
}

// Spec §5.4, §7: a clean answer needs every reachable object read; anything less is `incomplete`.
describe("scanCandidateHistory", () => {
  it("calls a clean history clean and writes nothing to the quarantine or the user's repository", async () => {
    const world = makeCandidateWorld({ workId: "w1", work: [{ files: { "src/app.ts": "export const app = 2;\n" } }] });
    const imported = await importCandidate(world);
    const quarantineBefore = snapshotGitDir(imported.quarantine.gitDir, { objects: true });
    const userBefore = snapshotGitDir(`${world.userRepo}/.git`, { objects: true });
    const scan = await scanCandidateHistory({
      quarantine: imported.quarantine,
      head: imported.head,
      credential: credential(),
      canaries: NO_CANARIES,
      maxTotalBytes: CAP,
    });
    expect(scan).toEqual({ status: "clean" });
    expect(imported.quarantine.workTree).toBeUndefined();
    const none = { added: [], changed: [], removed: [] };
    expect(diffSnapshots(quarantineBefore, snapshotGitDir(imported.quarantine.gitDir, { objects: true }))).toEqual(
      none,
    );
    expect(diffSnapshots(userBefore, snapshotGitDir(`${world.userRepo}/.git`, { objects: true }))).toEqual(none);
  });

  it("is incomplete, never clean, when the byte cap is hit or a seal could not be verified", async () => {
    const world = makeCandidateWorld({ workId: "w1" });
    const imported = await importCandidate(world);
    const base = { quarantine: imported.quarantine, head: imported.head, credential: credential() };
    expect(await scanCandidateHistory({ ...base, canaries: NO_CANARIES, maxTotalBytes: 8 })).toEqual({
      status: "incomplete",
    });
    expect(
      await scanCandidateHistory({
        ...base,
        canaries: { ...NO_CANARIES, unverified: ["seal-1"] },
        maxTotalBytes: CAP,
      }),
    ).toEqual({ status: "incomplete" });
  });
});
