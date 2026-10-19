import { describe, expect, it } from "vitest";
import { sweepItemOrphans } from "../../src/container/item-sweep.js";
import { claimItem, releaseItem } from "../../src/work/claim.js";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { sweepOrphans } from "../../src/judge/state.js";
import { imageIdFor } from "../helpers/image-id.js";
import { FakeDocker } from "../helpers/fake-docker.js";
import { addImage } from "../helpers/fake-docker-core.mjs";
import { fakeRuntime } from "../helpers/fake-runtime.js";
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

describe("the item sweep removes the host staging of a run that is not live", () => {
  const stage = (item: string, run: string): void => {
    put(item, `runs/${run}/judge/${"1-train"}/ctx`, "x");
    put(item, `runs/${run}/judge/wc-1-1/tree`, "x");
    put(item, `runs/${run}/implementer-stage/round-1/quarantine/blob`, "x");
    put(item, `runs/${run}/implementer-stage/round-1/tree-1/file`, "x");
    put(item, `runs/${run}/implementer/round-1/implementer.log`, "log");
    put(item, `runs/${run}/marker`, "x");
  };

  it("removes runs/<id>/judge and runs/<id>/implementer-stage of an earlier run while the claim is free, and keeps the logs", async () => {
    const item = realTempDir("omf-sweep-stage-");
    stage(item, EARLIER);
    await sweepItemOrphans({ runtime: new MemoryRuntime(), itemDir: item, workId: X });
    expect(existsSync(join(item, "runs", EARLIER, "judge"))).toBe(false);
    expect(existsSync(join(item, "runs", EARLIER, "implementer-stage"))).toBe(false);
    expect(existsSync(join(item, "runs", EARLIER, "implementer", "round-1", "implementer.log"))).toBe(true);
    expect(existsSync(join(item, "runs", EARLIER, "marker"))).toBe(true);
  });

  it("keeps them while a live process holds the claim, and for the current pass", async () => {
    const item = realTempDir("omf-sweep-stage-");
    stage(item, EARLIER);
    stage(item, CURRENT);
    claimItem(item);
    try {
      await sweepItemOrphans({ runtime: new MemoryRuntime(), itemDir: item, workId: X, currentPassId: CURRENT });
    } finally {
      releaseItem(item);
    }
    expect(existsSync(join(item, "runs", EARLIER, "judge"))).toBe(true);
    expect(existsSync(join(item, "runs", EARLIER, "implementer-stage"))).toBe(true);
    await sweepItemOrphans({ runtime: new MemoryRuntime(), itemDir: item, workId: X, currentPassId: CURRENT });
    expect(existsSync(join(item, "runs", EARLIER, "judge"))).toBe(false);
    expect(existsSync(join(item, "runs", CURRENT, "judge"))).toBe(true);
    expect(existsSync(join(item, "runs", CURRENT, "implementer-stage"))).toBe(true);
  });

  it("removes the staging even when the daemon cannot answer the listing", async () => {
    const item = realTempDir("omf-sweep-stage-");
    stage(item, EARLIER);
    const memory = new MemoryRuntime();
    memory.listOwned = async () => {
      throw new Error("daemon down");
    };
    expect(await sweepItemOrphans({ runtime: memory, itemDir: item, workId: X })).toBe(0);
    expect(existsSync(join(item, "runs", EARLIER, "judge"))).toBe(false);
  });

  it("leaves the target of a symlink alone: a linked judge directory is unlinked, a linked run directory is skipped", async () => {
    const item = realTempDir("omf-sweep-stage-");
    const outside = realTempDir("omf-sweep-outside-");
    put(outside, "keep/file", "x");
    put(outside, "judge/file", "x");
    put(outside, "implementer-stage/file", "x");
    mkdirSync(join(item, "runs", EARLIER), { recursive: true });
    symlinkSync(join(outside, "keep"), join(item, "runs", EARLIER, "judge"));
    symlinkSync(outside, join(item, "runs", "r-20261002T090000Z-cccc"));
    await sweepItemOrphans({ runtime: new MemoryRuntime(), itemDir: item, workId: X });
    expect(existsSync(join(item, "runs", EARLIER, "judge"))).toBe(false);
    expect(existsSync(join(outside, "keep", "file"))).toBe(true);
    expect(existsSync(join(outside, "judge", "file"))).toBe(true);
    expect(existsSync(join(outside, "implementer-stage", "file"))).toBe(true);
  });
});

describe("the run-start sweep does not follow a symlink either", () => {
  it("unlinks a linked judge directory and skips a linked run directory, leaving their targets", async () => {
    const item = realTempDir("omf-sweep-stage-");
    const outside = realTempDir("omf-sweep-outside-");
    put(outside, "keep/file", "x");
    put(outside, "judge/file", "x");
    mkdirSync(join(item, "runs", EARLIER), { recursive: true });
    symlinkSync(join(outside, "keep"), join(item, "runs", EARLIER, "judge"));
    symlinkSync(outside, join(item, "runs", "r-20261002T090000Z-cccc"));
    const result = await sweepOrphans({
      runtime: new MemoryRuntime(),
      itemDir: item,
      workId: X,
      currentRunId: CURRENT,
    });
    expect(result.staging).toBe(1);
    expect(existsSync(join(outside, "keep", "file"))).toBe(true);
    expect(existsSync(join(outside, "judge", "file"))).toBe(true);
  });
});

describe("the item sweep removes round images by item and run id", () => {
  const image = (run: string, round: number, work: string) => ({
    kind: "image" as const,
    name: `omf-sut:${run}-${round}`,
    run_id: run,
    work_id: work,
  });

  it("two items share a run id: sweeping item Y never removes item X's round image", async () => {
    const itemY = realTempDir("omf-sweep-image-y-");
    put(itemY, `runs/${EARLIER}/marker`, "x");
    const memory = new MemoryRuntime();
    memory.owned = [image(EARLIER, 1, X), image(EARLIER, 2, Y), image(EARLIER, 3, "")];
    await sweepItemOrphans({ runtime: memory, itemDir: itemY, workId: Y });
    expect(memory.owned.map((resource) => resource.name).sort()).toEqual(
      [`omf-sut:${EARLIER}-1`, `omf-sut:${EARLIER}-3`].sort(),
    );
    expect(memory.calls.filter((call) => call.startsWith("rmi "))).toEqual([
      `rmi ${imageIdFor(`omf-sut:${EARLIER}-2`)}`,
    ]);
  });

  it("keeps the current pass, an unknown run, the cached harness image and, while a live process holds the claim, every round image", async () => {
    const item = realTempDir("omf-sweep-image-");
    put(item, `runs/${EARLIER}/marker`, "x");
    put(item, `runs/${CURRENT}/marker`, "x");
    const memory = new MemoryRuntime();
    memory.owned = [
      image(CURRENT, 1, X),
      image("r-20260101T000000Z-ffff", 1, X),
      { kind: "image", name: "omf-harness:0123456789ab", run_id: "", work_id: X },
      image(EARLIER, 1, X),
    ];
    claimItem(item);
    try {
      await sweepItemOrphans({ runtime: memory, itemDir: item, workId: X, currentPassId: CURRENT });
    } finally {
      releaseItem(item);
    }
    expect(memory.owned).toHaveLength(4);
    await sweepItemOrphans({ runtime: memory, itemDir: item, workId: X, currentPassId: CURRENT });
    expect(memory.owned.map((resource) => resource.name).sort()).toEqual(
      [`omf-sut:${CURRENT}-1`, "omf-sut:r-20260101T000000Z-ffff-1", "omf-harness:0123456789ab"].sort(),
    );
  });
});

describe("a round image is removed by the id read when it was listed", () => {
  const WORK = "w-0123456789ab";
  const RUN = "r-20261001T090000Z-aaaa";
  const tag = `omf-sut:${RUN}-1`;
  const setup = () => {
    const fake = new FakeDocker();
    const mine = addImage(fake.state, tag, { labels: { "omf.owner": "omf", "omf.work": WORK, "omf.run": RUN } });
    const other = addImage(fake.state, "omf-sut:other-staging", {
      labels: { "omf.owner": "omf", "omf.work": "w-ba9876543210", "omf.run": RUN },
    });
    const base = fakeRuntime(fake);
    // Between the listing and the removal another item takes the tag over.
    const runtime = {
      ...base,
      listOwned: async (filter: { run_id: string | null }) => {
        const listed = await base.listOwned(filter);
        const mineImage = fake.state.images[mine];
        const otherImage = fake.state.images[other];
        if (mineImage !== undefined && otherImage !== undefined) {
          mineImage.tags = [];
          otherImage.tags = [tag];
        }
        return listed;
      },
    };
    return { fake, runtime, mine, other };
  };

  it("lists the image id next to the tag", async () => {
    const { fake, mine } = setup();
    const listed = await fakeRuntime(fake).listOwned({ run_id: null });
    expect(listed.find((resource) => resource.name === tag)?.image_id).toBe(mine);
  });

  it("item sweep: a tag taken over after the listing is not removed", async () => {
    const { fake, runtime, mine, other } = setup();
    const item = realTempDir("omf-sweep-retag-");
    put(item, `runs/${RUN}/marker`, "x");
    expect(await sweepItemOrphans({ runtime, itemDir: item, workId: WORK })).toBe(1);
    expect(fake.state.images[mine]).toBeUndefined();
    expect(fake.state.images[other]).toBeDefined();
  });

  it("run-start sweep: a tag taken over after the listing is not removed", async () => {
    const { fake, runtime, mine, other } = setup();
    const item = realTempDir("omf-sweep-retag-");
    put(item, `runs/${RUN}/marker`, "x");
    await sweepOrphans({ runtime, itemDir: item, currentRunId: "r-20261019T100000Z-bbbb", workId: WORK });
    expect(fake.state.images[mine]).toBeUndefined();
    expect(fake.state.images[other]).toBeDefined();
  });
});
