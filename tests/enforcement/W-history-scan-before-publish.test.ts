import { describe, expect, it } from "vitest";
import { readCredential } from "../../src/implementer/credential.js";
import { type VaultCanaryIndex, scanCandidateHistory } from "../../src/implementer/history-scan.js";
import { importCandidate } from "../helpers/candidate-import.js";
import { type WorkCommit, makeCandidateWorld } from "../helpers/git-fixture.js";

const KEY = "sk-ant-test-0123456789abcdefghijklmnop";
const CANARY = "omf-vault-canary-7c1e9d42b8a05f36";
const CANARIES: VaultCanaryIndex = {
  index: [{ canary: CANARY, scenario_ref: "scenario-1", seal_id: "seal-1", scenario_id: "sc-1" }],
  unverified: [],
  unverified_canaries: [],
};

// Spec §5.4, §7: what a candidate carried at any point is on the branch that is published, so every object reachable
// from the head is read before anything is published. That the station publishes only after a clean scan is tested with the station.
describe("W-history-scan-before-publish", () => {
  const cases: ReadonlyArray<readonly [string, readonly WorkCommit[], "credential" | "canary"]> = [
    ["the credential in the head tree", [{ files: { "leak.txt": `key=${KEY}\n` } }], "credential"],
    [
      "the credential in a commit that a later commit removes",
      [{ files: { "leak.txt": `${KEY}\n` } }, { files: { "leak.txt": null } }],
      "credential",
    ],
    ["the credential only in a commit message", [{ files: { "a.txt": "a\n" }, message: `note ${KEY}` }], "credential"],
    ["the credential only in a file name", [{ files: { [`leak-${KEY}.txt`]: "x\n" } }], "credential"],
    ["a vault canary in the head tree", [{ files: { "c.txt": `${CANARY}\n` } }], "canary"],
    [
      "a vault canary in a commit that a later commit removes",
      [{ files: { "c.txt": `${CANARY}\n` } }, { files: { "c.txt": null } }],
      "canary",
    ],
    ["a vault canary only in a commit message", [{ files: { "a.txt": "a\n" }, message: `see ${CANARY}` }], "canary"],
  ];

  it.each(cases)("finds %s", async (_name, work, expected) => {
    const credential = readCredential("claude", { ANTHROPIC_API_KEY: KEY });
    if (credential === null) throw new Error("the test credential was rejected");
    const world = makeCandidateWorld({ workId: "w1", work });
    const imported = await importCandidate(world);
    const scan = await scanCandidateHistory({
      quarantine: imported.quarantine,
      head: imported.head,
      credential,
      canaries: CANARIES,
      maxTotalBytes: 64 * 1024 * 1024,
    });
    expect(scan).toEqual({ status: expected });
  });
});
