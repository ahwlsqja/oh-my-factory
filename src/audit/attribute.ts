import { type AuditSurface, scanCanaries } from "./canary-scan.js";

/** One canary of the vault and the scenario it was written into. Host-only: `scenario_id` never reaches the ledger. */
export interface CanaryIndexEntry {
  canary: string;
  scenario_ref: string;
  seal_id: string;
  scenario_id: string;
}

/**
 * Names the scenarios whose canary is on a surface. The aggregate scan reports counts only, so after it found a hit this
 * narrows down which canaries were it: scan the group, and when something is found split the group in halves. One hit among
 * n canaries costs about 2 log2(n) scans instead of n, which matters because the worktree surface is a full tree walk.
 * `required` is empty on purpose: whether the aggregate scan was complete is the aggregate's business, here a hit is a hit.
 * Every surface must be readable more than once.
 */
export async function attributeCanaryHits(
  index: readonly CanaryIndexEntry[],
  surfaces: readonly AuditSurface[],
): Promise<CanaryIndexEntry[]> {
  const narrow = async (group: readonly CanaryIndexEntry[]): Promise<CanaryIndexEntry[]> => {
    if (group.length === 0) return [];
    const scan = await scanCanaries(
      group.map((entry) => entry.canary),
      surfaces,
      [],
    );
    if (scan.total === 0) return [];
    if (group.length === 1) return [...group];
    const middle = Math.ceil(group.length / 2);
    return [...(await narrow(group.slice(0, middle))), ...(await narrow(group.slice(middle)))];
  };
  return narrow(index);
}
