import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ContainerRuntime } from "./runtime.js";
import { assertName } from "./spec.js";
import { isLockHeld, sealLockFile } from "../core/lock.js";
import { claimStatus } from "../work/claim.js";

interface ItemSweepInput {
  runtime: Pick<ContainerRuntime, "listOwned" | "remove">;
  itemDir: string;
  /** The pass of the calling `omf seal`, whose marker may already exist; never selected. */
  currentPassId?: string;
}

/**
 * One item-level sweep for a command that holds neither `seal.lock` nor the item claim. It removes this item's author orphans
 * while `seal.lock` is free and this item's implementer orphans while the claim is not held by a live run, so a live
 * container is never removed. Race-free order, the same as `sweepOrphans` (src/judge/state.ts): the directories under `runs/`
 * are read first, then each lock is probed, then the daemon is listed once. A pass or run that starts after the read has
 * a marker this sweep never saw, so its container is not selected whatever the probes say. Nothing is listed when both
 * roles are held. Best effort: any failure (an unreadable claim, a daemon that cannot answer) removes nothing more, leaves
 * the orphan for the next command and never changes what the command reports.
 */
export async function sweepItemOrphans(
  input: ItemSweepInput & { roles?: readonly ("author" | "implementer")[] },
): Promise<number> {
  const roles = input.roles ?? ["author", "implementer"];
  try {
    const runsDir = join(input.itemDir, "runs");
    const earlier = new Set(existsSync(runsDir) ? readdirSync(runsDir) : []);
    earlier.delete(input.currentPassId ?? "");
    const free = {
      author: roles.includes("author") && !isLockHeld(sealLockFile(input.itemDir)),
      implementer: roles.includes("implementer") && !claimHeld(input.itemDir),
    };
    if (!free.author && !free.implementer) return 0;
    let removed = 0;
    for (const resource of await input.runtime.listOwned({ run_id: null })) {
      if (resource.kind !== "container" || !earlier.has(resource.run_id)) continue;
      const role = resource.name.startsWith("omf-author-")
        ? "author"
        : resource.name.startsWith("omf-implementer-")
          ? "implementer"
          : null;
      if (role === null || !free[role]) continue;
      try {
        assertName(resource.name);
      } catch {
        continue;
      }
      await input.runtime.remove({ name: resource.name, id: resource.name, role });
      removed += 1;
    }
    return removed;
  } catch {
    return 0;
  }
}

/** A claim that cannot be read counts as held: the sweep keeps what it cannot prove orphaned. */
function claimHeld(itemDir: string): boolean {
  try {
    return claimStatus(itemDir).held;
  } catch {
    return true;
  }
}

/** `sweepItemOrphans` for the author role only. */
export function sweepItemAuthorOrphans(input: ItemSweepInput): Promise<number> {
  return sweepItemOrphans({ ...input, roles: ["author"] });
}
