import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sweepAuthorOrphans } from "../../src/author/station.js";
import { MemoryRuntime } from "../helpers/memory-runtime.js";
import { realTempDir } from "../helpers/ops-fixture.js";

const WORK = "w-0123456789ab";
const EARLIER = "r-20261001T090000Z-aaaa";
const CURRENT = "r-20261019T100000Z-bbbb";

function runtimeWithOrphan(): MemoryRuntime {
  const memory = new MemoryRuntime();
  memory.owned = [{ kind: "container", name: `omf-author-${EARLIER}-1-1`, run_id: EARLIER, work_id: WORK }];
  return memory;
}

describe("sweepAuthorOrphans reads the item's runs directory like the other sweeps", () => {
  it("removes the author container of an earlier pass when runs is a plain directory", async () => {
    const item = realTempDir("omf-author-orphans-");
    mkdirSync(join(item, "runs", EARLIER), { recursive: true });
    const memory = runtimeWithOrphan();
    expect(await sweepAuthorOrphans({ runtime: memory, itemDir: item, currentPassId: CURRENT, workId: WORK })).toBe(1);
    expect(memory.calls).toEqual([`remove omf-author-${EARLIER}-1-1`]);
  });

  it("does nothing when runs is a symlink, however the link resolves", async () => {
    const item = realTempDir("omf-author-orphans-");
    const outside = realTempDir("omf-author-orphans-outside-");
    mkdirSync(join(outside, EARLIER), { recursive: true });
    symlinkSync(outside, join(item, "runs"));
    const memory = runtimeWithOrphan();
    expect(await sweepAuthorOrphans({ runtime: memory, itemDir: item, currentPassId: CURRENT, workId: WORK })).toBe(0);
    expect(memory.calls).toEqual([]);
  });

  it("does nothing when the item has no runs directory", async () => {
    const memory = runtimeWithOrphan();
    const item = realTempDir("omf-author-orphans-");
    expect(await sweepAuthorOrphans({ runtime: memory, itemDir: item, currentPassId: CURRENT, workId: WORK })).toBe(0);
    expect(memory.calls).toEqual([]);
  });
});
