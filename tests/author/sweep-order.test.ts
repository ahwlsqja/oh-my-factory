import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sweepItemOrphans } from "../../src/container/item-sweep.js";
import { acquireLock, releaseLock, sealLockFile } from "../../src/core/lock.js";
import { claimItem, releaseItem } from "../../src/work/claim.js";
import { MemoryRuntime } from "../helpers/memory-runtime.js";
import { put, realTempDir } from "../helpers/ops-fixture.js";

// The race a sweep must close: a pass or run that starts while the sweep is looking. The sweep reads `runs/` first, then asks
// whether the lock is held, then lists. A start after the read has a marker the sweep never saw, so its container is not
// selected even when the probe still answered "free". The hook below fires right after the first probe answered "free", which
// is the one moment where the old order (probe, then read `runs/`) removed a live container: with the two steps swapped in
// sweepItemOrphans, the marker the hook creates is read, and the STARTING container is removed (the test fails on that, not on a missing file).
const hooks = vi.hoisted(() => ({ afterProbe: null as null | (() => void) }));
vi.mock("../../src/core/lock.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/lock.js")>();
  return {
    ...real,
    isLockHeld: (path: string): boolean => {
      const held = real.isLockHeld(path);
      const fire = hooks.afterProbe;
      hooks.afterProbe = null;
      fire?.();
      return held;
    },
  };
});
vi.mock("../../src/work/claim.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/work/claim.js")>();
  return {
    ...real,
    claimStatus: (itemDir: string) => {
      const status = real.claimStatus(itemDir);
      const fire = hooks.afterProbe;
      hooks.afterProbe = null;
      fire?.();
      return status;
    },
  };
});

const WORK = "w-0123456789ab";
const EARLIER = "r-20261001T090000Z-aaaa";
const STARTING = "r-20261019T100000Z-bbbb";

afterEach(() => {
  hooks.afterProbe = null;
});

describe("the item sweep reads runs/ before it probes the lock", () => {
  it("keeps the author container of a pass that starts after the read, and removes the earlier one in the same call", async () => {
    const itemDir = realTempDir("omf-sweep-order-");
    put(itemDir, `runs/${EARLIER}/marker`, "x");
    const memory = new MemoryRuntime();
    memory.owned = [
      { kind: "container", name: `omf-author-${EARLIER}-1-1`, run_id: EARLIER, work_id: WORK },
      { kind: "container", name: `omf-author-${STARTING}-1-1`, run_id: STARTING, work_id: WORK },
    ];
    const lock = sealLockFile(itemDir);
    hooks.afterProbe = () => {
      // The pass starts: its lock, then its marker, then (already in the list below) its container.
      acquireLock(lock);
      mkdirSync(join(itemDir, "runs", STARTING), { recursive: true });
    };
    try {
      expect(
        await sweepItemOrphans({ runtime: memory, itemDir, projectDir: itemDir, workId: WORK, roles: ["author"] }),
      ).toBe(1);
    } finally {
      releaseLock(lock);
    }
    expect(memory.owned.map((resource) => resource.name)).toEqual([`omf-author-${STARTING}-1-1`]);
  });

  it("keeps the implementer container of a run that starts after the read, and removes the earlier one in the same call", async () => {
    const itemDir = realTempDir("omf-sweep-order-");
    put(itemDir, `runs/${EARLIER}/marker`, "x");
    const memory = new MemoryRuntime();
    memory.owned = [
      { kind: "container", name: `omf-implementer-${EARLIER}-1-1`, run_id: EARLIER, work_id: WORK },
      { kind: "container", name: `omf-implementer-${STARTING}-1-1`, run_id: STARTING, work_id: WORK },
    ];
    hooks.afterProbe = () => {
      claimItem(itemDir);
      mkdirSync(join(itemDir, "runs", STARTING), { recursive: true });
    };
    try {
      expect(
        await sweepItemOrphans({ runtime: memory, itemDir, projectDir: itemDir, workId: WORK, roles: ["implementer"] }),
      ).toBe(1);
    } finally {
      releaseItem(itemDir);
    }
    expect(memory.owned.map((resource) => resource.name)).toEqual([`omf-implementer-${STARTING}-1-1`]);
  });
});
