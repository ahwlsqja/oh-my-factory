import { describe, expect, it } from "vitest";
import { sweepItemOrphans } from "../../src/container/item-sweep.js";
import { claimItem, releaseItem } from "../../src/work/claim.js";
import { MemoryRuntime } from "../helpers/memory-runtime.js";
import { put, realTempDir } from "../helpers/ops-fixture.js";

const SHARED_RUN = "r-20261001T090000Z-aaaa";
const X = "w-0123456789ab";
const Y = "w-ba9876543210";

describe("the item sweep selects by item, not by run id alone", () => {
  it("never removes the container of item X when item Y is swept and both planted the same run id", async () => {
    const itemY = realTempDir("omf-sweep-y-");
    put(itemY, `runs/${SHARED_RUN}/marker`, "x");
    const memory = new MemoryRuntime();
    memory.owned = [
      { kind: "container", name: `omf-author-${SHARED_RUN}-1-1`, run_id: SHARED_RUN, work_id: X },
      { kind: "container", name: `omf-implementer-${SHARED_RUN}-1-2`, run_id: SHARED_RUN, work_id: X },
      { kind: "container", name: `omf-author-${SHARED_RUN}-2-1`, run_id: SHARED_RUN, work_id: Y },
      { kind: "container", name: `omf-implementer-${SHARED_RUN}-2-2`, run_id: SHARED_RUN, work_id: Y },
    ];
    expect(await sweepItemOrphans({ runtime: memory, itemDir: itemY, workId: Y })).toBe(2);
    expect(memory.owned.map((resource) => resource.name).sort()).toEqual(
      [`omf-author-${SHARED_RUN}-1-1`, `omf-implementer-${SHARED_RUN}-1-2`].sort(),
    );
  });
});

const JUDGE = ["sut", "harness", "workcopy"] as const;
const EARLIER = "r-20261001T090000Z-aaaa";
const CURRENT = "r-20261019T100000Z-bbbb";
const judgeOf = (run: string, work: string, serial = 1) =>
  JUDGE.map((role) => ({
    kind: "container" as const,
    name: `omf-${role}-${run}-1-${serial}`,
    run_id: run,
    work_id: work,
  }));

describe("the item sweep reaches the judge roles", () => {
  it("removes the SUT, harness and work copy containers of an earlier run while the claim is free", async () => {
    const item = realTempDir("omf-sweep-judge-");
    put(item, `runs/${EARLIER}/marker`, "x");
    const memory = new MemoryRuntime();
    memory.owned = judgeOf(EARLIER, X);
    expect(await sweepItemOrphans({ runtime: memory, itemDir: item, workId: X })).toBe(3);
    expect(memory.owned).toEqual([]);
    expect(memory.calls.filter((call) => call.startsWith("remove "))).toHaveLength(3);
  });

  it("keeps them while a live process holds the claim, and removes the agent orphans in the same call", async () => {
    const item = realTempDir("omf-sweep-judge-");
    put(item, `runs/${EARLIER}/marker`, "x");
    const memory = new MemoryRuntime();
    memory.owned = [
      ...judgeOf(EARLIER, X),
      { kind: "container", name: `omf-author-${EARLIER}-1-9`, run_id: EARLIER, work_id: X },
    ];
    claimItem(item);
    try {
      expect(await sweepItemOrphans({ runtime: memory, itemDir: item, workId: X })).toBe(1);
    } finally {
      releaseItem(item);
    }
    expect(memory.owned.map((resource) => resource.name).sort()).toEqual(
      judgeOf(EARLIER, X)
        .map((r) => r.name)
        .sort(),
    );
  });

  it("never removes the current pass, another item's containers, or a name off the pattern", async () => {
    const item = realTempDir("omf-sweep-judge-");
    put(item, `runs/${EARLIER}/marker`, "x");
    put(item, `runs/${CURRENT}/marker`, "x");
    const memory = new MemoryRuntime();
    memory.owned = [
      ...judgeOf(CURRENT, X),
      ...judgeOf(EARLIER, Y, 2),
      { kind: "container", name: `omf-sut-${EARLIER}-oops`, run_id: EARLIER, work_id: X },
    ];
    const before = memory.owned.map((resource) => resource.name).sort();
    expect(await sweepItemOrphans({ runtime: memory, itemDir: item, workId: X, currentPassId: CURRENT })).toBe(0);
    expect(memory.owned.map((resource) => resource.name).sort()).toEqual(before);
  });

  it("keeps the judge containers when the sweep is limited to the author role", async () => {
    const item = realTempDir("omf-sweep-judge-");
    put(item, `runs/${EARLIER}/marker`, "x");
    const memory = new MemoryRuntime();
    memory.owned = judgeOf(EARLIER, X);
    expect(await sweepItemOrphans({ runtime: memory, itemDir: item, workId: X, roles: ["author"] })).toBe(0);
    expect(memory.owned).toHaveLength(3);
  });
});
