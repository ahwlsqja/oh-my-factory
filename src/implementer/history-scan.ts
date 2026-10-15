import { HostGitError, type GitTarget } from "../git/hardened.js";
import { reachableObjects, readObjectsBatch } from "../git/ops.js";
import type { listVaultCanaryIndex } from "../vault/vault.js";
import { type Credential, containsCredential } from "./credential.js";

/** What `listVaultCanaryIndex` returns: the verified canaries, the seals that did not verify and their canary-shaped strings. */
export type VaultCanaryIndex = ReturnType<typeof listVaultCanaryIndex>;

export type HistoryScan =
  | { status: "clean" }
  | { status: "credential" }
  | { status: "canary" }
  | { status: "incomplete" };

/** More reachable objects than this is not a session's work; the scan reports `incomplete` instead of reading them. */
export const MAX_SCANNED_OBJECTS = 200_000;

/**
 * Reads every commit, tree and blob reachable from `head` in the quarantine (no checkout: `cat-file --batch`) and looks for
 * the credential and for the vault canaries in their raw bytes (spec §5.4, §7). Reading every reachable object, not
 * only the head tree, finds a value that was committed and removed again, because the published branch carries it. Commit
 * objects hold the messages, and tree objects hold the file names, so a value that appears only there is found too. The
 * first hit ends the scan (a credential hit and a canary hit are reported separately, never merged).
 *
 * Fails closed: an object count or byte total over the caps, a git failure, or a seal whose canaries could not be verified
 * is `incomplete`, never `clean`. A hit is still reported when the scan could not finish, because a seen value is evidence.
 */
export async function scanCandidateHistory(input: {
  quarantine: GitTarget;
  head: string;
  credential: Credential;
  canaries: VaultCanaryIndex;
  maxTotalBytes: number;
}): Promise<HistoryScan> {
  const needles = [
    ...new Set([...input.canaries.index.map((entry) => entry.canary), ...input.canaries.unverified_canaries]),
  ]
    .filter((canary) => canary.length > 0)
    .map((canary) => Buffer.from(canary, "utf8"));
  try {
    const objects = await reachableObjects(input.quarantine, input.head, MAX_SCANNED_OBJECTS);
    const shas = objects.map((object) => object.sha);
    for await (const object of readObjectsBatch(input.quarantine, shas, input.maxTotalBytes)) {
      if (containsCredential(object.bytes, input.credential)) return { status: "credential" };
      if (needles.some((needle) => object.bytes.includes(needle))) return { status: "canary" };
    }
  } catch (error) {
    if (error instanceof HostGitError) return { status: "incomplete" };
    throw error;
  }
  return input.canaries.unverified.length > 0 ? { status: "incomplete" } : { status: "clean" };
}
