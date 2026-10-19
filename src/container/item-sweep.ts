import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { omfHome } from "../core/paths.js";
import type { ContainerRuntime } from "./runtime.js";
import { type ImageId, assertName } from "./spec.js";
import { UNREADABLE_GRACE_MS, isLockHeld, sealLockFile } from "../core/lock.js";
import { claimFile, claimStatus } from "../work/claim.js";

/** The roles the item sweep can reach: the two agent roles and the three judge roles. */
export type SweepRole = "author" | "implementer" | "sut" | "harness" | "workcopy";
const ALL_ROLES: readonly SweepRole[] = ["author", "implementer", "sut", "harness", "workcopy"];
const ROLE_OF_NAME = /^omf-(sut|harness|workcopy|implementer|author)-/;

/** The staging directories under `runs/<id>/` a killed run can leave: judge work copies and build contexts, implementer bundle, quarantine and tree. */
export const STAGING_DIRS: readonly string[] = ["judge", "implementer-stage"];

/** A plain directory, not a symlink to one: the sweeps never enter a `runs` that is anything else. */
function isPlainDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The run ids under `<item>/runs`: none when it does not exist, and null when it is not a plain directory (a symlink, a file),
 * which a sweep answers by doing nothing at all.
 */
export function readRunIds(runsDir: string): string[] | null {
  if (!existsSync(runsDir) && !isSymlink(runsDir)) return [];
  return isPlainDir(runsDir) ? readdirSync(runsDir) : null;
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Whether `runsDir` really lives where it is written: the real path of `runsDir` equals the path as written under the project
 * OMF state root (the real path of the OMF home plus the part of the written path below it, so a symlinked home is no
 * symlink in the tree). A symlink anywhere above `runs` (`goals`, `goals/<g>`, `work`, the work id directory) makes the real
 * path differ, and the staging below it may be a directory outside the state tree. A `runsDir` that is not under the OMF home
 * (a caller that hands its own item directory) is compared with itself as written. Any failure to resolve says no.
 */
export function runsOnStatePath(runsDir: string): boolean {
  try {
    const written = resolve(runsDir);
    let expected = written;
    try {
      const home = resolve(omfHome());
      const below = relative(home, written);
      if (below !== "" && below !== ".." && !below.startsWith(`..${sep}`) && resolve(home, below) === written) {
        expected = join(realpathSync.native(home), below);
      }
    } catch {
      // no usable OMF home: the written path itself is the expectation
    }
    return realpathSync.native(runsDir) === expected;
  } catch {
    return false;
  }
}

/**
 * Removes the staging directories of the given runs, without following a symlink: a run directory that is not a plain directory
 * is skipped, and a staging entry that is a symlink is unlinked, never entered. Returns how many it removed. Best effort per
 * entry: one that cannot be removed is left for the next sweep. The run logs under `runs/<id>/implementer/` are not touched.
 * Nothing is removed unless `runsDir` is on the real state path (`runsOnStatePath`): a symlink above `runs` could point the
 * staging at a directory outside the state tree, which every caller (the item sweep and the run-start sweep) is then spared.
 */
export function removeStagingDirs(runsDir: string, runIds: Iterable<string>): number {
  if (!isPlainDir(runsDir) || !runsOnStatePath(runsDir)) return 0;
  let removed = 0;
  for (const runId of runIds) {
    const runDir = join(runsDir, runId);
    try {
      if (!lstatSync(runDir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const name of STAGING_DIRS) {
      const path = join(runDir, name);
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) unlinkSync(path);
        else if (stat.isDirectory()) rmSync(path, { recursive: true, force: true });
        else continue;
        removed += 1;
      } catch {
        // absent or not removable now: the next sweep tries again
      }
    }
  }
  return removed;
}

interface ItemSweepInput {
  runtime: Pick<ContainerRuntime, "listOwned" | "remove" | "removeImage">;
  itemDir: string;
  /** The item's id: a run id is only unique to the second, so a container counts only when its `omf.work` label is this item. */
  workId: string;
  /** The pass of the calling `omf seal`, whose marker may already exist; never selected. */
  currentPassId?: string;
}

/**
 * One item-level sweep for a command that holds neither `seal.lock` nor the item claim. It removes this item's author orphans
 * while `seal.lock` is free, and this item's implementer, SUT, harness and work copy orphans while the claim is not held by
 * a live run (the judge containers belong to the run that holds the claim), so a live container is never removed. While the
 * claim is free it also removes `runs/<id>/judge` and `runs/<id>/implementer-stage` of every earlier run (`removeStagingDirs`),
 * whatever the daemon answered. Race-free order, the same as `sweepOrphans` (src/judge/state.ts): the directories under `runs/`
 * are read first, then each lock is probed, then the daemon is listed once. A pass or run that starts after the read has
 * a marker this sweep never saw, so its container is not selected whatever the probes say. Nothing is listed when both
 * roles are held. Best effort: any failure (an unreadable claim, a daemon that cannot answer) removes nothing more of that
 * kind, leaves the orphan for the next command and never changes what the command reports.
 */
export async function sweepItemOrphans(input: ItemSweepInput & { roles?: readonly SweepRole[] }): Promise<number> {
  const roles = input.roles ?? ALL_ROLES;
  try {
    const runsDir = join(input.itemDir, "runs");
    const runIds = readRunIds(runsDir);
    if (runIds === null) return 0;
    const earlier = new Set(runIds);
    earlier.delete(input.currentPassId ?? "");
    const sealFree = roles.includes("author") && !isLockHeld(sealLockFile(input.itemDir));
    const wanted = roles.filter((role) => role !== "author");
    const claimFree = wanted.length > 0 && !claimHeld(input.itemDir);
    const free = (role: SweepRole): boolean => (role === "author" ? sealFree : claimFree && wanted.includes(role));
    if (!sealFree && !claimFree) return 0;
    let removed = 0;
    try {
      for (const resource of await input.runtime.listOwned({ run_id: null })) {
        if (resource.work_id !== input.workId || !earlier.has(resource.run_id)) continue;
        // A round image is selected like a container, by its `omf.work` label and run id; the cached harness image is kept.
        if (resource.kind === "image") {
          if (claimFree && resource.name.startsWith("omf-sut:") && resource.image_id !== undefined) {
            // By the id read at inspect time, so a tag another item took over since the listing is not removed.
            await input.runtime.removeImage(resource.image_id as ImageId);
            removed += 1;
          }
          continue;
        }
        const role = ROLE_OF_NAME.exec(resource.name)?.[1] as SweepRole | undefined;
        if (role === undefined || !free(role)) continue;
        try {
          assertName(resource.name);
        } catch {
          continue;
        }
        await input.runtime.remove({ name: resource.name, id: resource.name, role });
        removed += 1;
      }
    } catch {
      // the daemon cannot answer: the host staging below is still swept
    }
    if (claimFree) removeStagingDirs(runsDir, earlier);
    return removed;
  } catch {
    return 0;
  }
}

/**
 * Whether the sweep must treat the claim as held. A claim whose owner is readable is held while that process lives. A claim with
 * no readable owner counts as held only for the grace `isLockHeld` gives a lock file mid-write; an older one is not held for
 * the sweep. `claimStatus` itself is unchanged: such a claim still keeps the item unrunnable until it is removed by hand.
 * Any other failure to read it counts as held: the sweep keeps what it cannot prove orphaned.
 */
function claimHeld(itemDir: string): boolean {
  try {
    const status = claimStatus(itemDir);
    if (!status.held) return false;
    if (status.owner !== null) return true;
    try {
      return Date.now() - statSync(claimFile(itemDir)).mtimeMs <= UNREADABLE_GRACE_MS;
    } catch (err) {
      // Only a claim that vanished is not held; any other failure to read it keeps the orphan.
      return (err as NodeJS.ErrnoException).code !== "ENOENT";
    }
  } catch {
    return true;
  }
}
