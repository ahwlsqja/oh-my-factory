import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ContainerHandle } from "../../src/container/runtime.js";
import { assertName, type ImageId } from "../../src/container/spec.js";
import { acquireLock, releaseLock, sealLockFile } from "../../src/core/lock.js";
import { sweepImplementerContainers, sweepOrphans } from "../../src/judge/state.js";
import { MemoryRuntime } from "../helpers/memory-runtime.js";
import { put, realTempDir } from "../helpers/ops-fixture.js";
import { waitForPids } from "../helpers/process.js";

const CHILD = fileURLToPath(new URL("../helpers/lifecycle-child.mjs", import.meta.url));
const EARLIER = "r-20261001T090000Z-aaaa";
const CURRENT = "r-20261015T090000Z-bbbb";
const OTHER_ITEM = "r-20261002T090000Z-cccc";
const CHILD_RUN = "r-20261014T091500Z-ab12"; // the run id lifecycle-child.mjs uses

// A run that was killed with SIGKILL runs no handler. The next run of the same work item sweeps what it left: containers and
// round images of an earlier run (found through the run directories under <item>/runs), and those runs' host build contexts.
describe("W-judge-leak-sweep", () => {
  it("removes the containers, round images and build contexts of this item's earlier runs, and nothing else", async () => {
    const itemDir = realTempDir("omf-sweep-item-");
    put(itemDir, `runs/${EARLIER}/audit-1.json`, "{}");
    put(itemDir, `runs/${EARLIER}/judge/1-train/ctx-sut/candidate.tar`, "x");
    put(itemDir, `runs/${CURRENT}/judge/1-train/keep`, "x");
    const memory = new MemoryRuntime();
    memory.owned = [
      { kind: "container", name: `omf-sut-${EARLIER}-1-1`, run_id: EARLIER },
      { kind: "container", name: `omf-workcopy-${EARLIER}-1-2`, run_id: EARLIER },
      { kind: "image", name: `omf-sut:${EARLIER}-1`, run_id: EARLIER },
      { kind: "image", name: "omf-harness:0123456789ab", run_id: EARLIER }, // the cached harness image is the exemption
      { kind: "container", name: `omf-sut-${CURRENT}-1-1`, run_id: CURRENT },
      { kind: "image", name: `omf-sut:${CURRENT}-1`, run_id: CURRENT },
      { kind: "container", name: `omf-sut-${OTHER_ITEM}-1-1`, run_id: OTHER_ITEM }, // another work item's run: not under this item's runs/
    ];
    const swept = await sweepOrphans({ runtime: memory, itemDir, currentRunId: CURRENT });
    expect(swept).toEqual({ containers: 2, images: 1, staging: 1, skipped: [] });
    expect(memory.owned.map((resource) => resource.name).sort()).toEqual(
      [
        "omf-harness:0123456789ab",
        `omf-sut-${CURRENT}-1-1`,
        `omf-sut-${OTHER_ITEM}-1-1`,
        `omf-sut:${CURRENT}-1`,
      ].sort(),
    );
    expect(existsSync(join(itemDir, "runs", EARLIER, "judge"))).toBe(false);
    expect(existsSync(join(itemDir, "runs", EARLIER, "audit-1.json"))).toBe(true);
    expect(existsSync(join(itemDir, "runs", CURRENT, "judge", "1-train", "keep"))).toBe(true);
    expect(await sweepOrphans({ runtime: memory, itemDir, currentRunId: CURRENT })).toEqual({
      containers: 0,
      images: 0,
      staging: 0,
      skipped: [],
    });
  });

  it("also removes an earlier pass's author container, but not while the item's seal.lock is held", async () => {
    const itemDir = realTempDir("omf-sweep-item-");
    put(itemDir, `runs/${EARLIER}/marker`, "x"); // the pass marker an author pass creates before its container
    const memory = new MemoryRuntime();
    memory.owned = [
      { kind: "container", name: `omf-author-${EARLIER}-1-1`, run_id: EARLIER },
      { kind: "container", name: `omf-sut-${EARLIER}-1-1`, run_id: EARLIER },
    ];
    acquireLock(sealLockFile(itemDir));
    try {
      expect(await sweepOrphans({ runtime: memory, itemDir, currentRunId: CURRENT })).toMatchObject({ containers: 1 });
      expect(memory.owned.map((resource) => resource.name)).toEqual([`omf-author-${EARLIER}-1-1`]);
    } finally {
      releaseLock(sealLockFile(itemDir));
    }
    expect(await sweepOrphans({ runtime: memory, itemDir, currentRunId: CURRENT })).toMatchObject({ containers: 1 });
    expect(memory.owned).toEqual([]);
  });

  it("leaves an author container of another item's run alone: only runs under this item's runs/ are selected", async () => {
    const itemDir = realTempDir("omf-sweep-item-");
    put(itemDir, `runs/${EARLIER}/marker`, "x");
    const memory = new MemoryRuntime();
    // This item's own earlier author container goes in the same call (red before the author role was swept); the other item's stays.
    memory.owned = [
      { kind: "container", name: `omf-author-${EARLIER}-1-1`, run_id: EARLIER },
      { kind: "container", name: `omf-author-${OTHER_ITEM}-1-1`, run_id: OTHER_ITEM },
    ];
    expect(await sweepOrphans({ runtime: memory, itemDir, currentRunId: CURRENT })).toMatchObject({ containers: 1 });
    expect(memory.owned.map((resource) => resource.run_id)).toEqual([OTHER_ITEM]);
  });

  it("sweepImplementerContainers removes this item's implementer containers, the current run's included, and nothing else", async () => {
    const itemDir = realTempDir("omf-sweep-item-");
    put(itemDir, `runs/${EARLIER}/marker`, "x");
    const memory = new MemoryRuntime();
    memory.owned = [
      { kind: "container", name: `omf-implementer-${EARLIER}-1-1`, run_id: EARLIER },
      { kind: "container", name: `omf-implementer-${CURRENT}-2-3`, run_id: CURRENT },
      { kind: "container", name: `omf-implementer-${OTHER_ITEM}-1-1`, run_id: OTHER_ITEM },
      { kind: "container", name: `omf-sut-${CURRENT}-1-1`, run_id: CURRENT },
      { kind: "container", name: `omf-author-${EARLIER}-1-1`, run_id: EARLIER },
      { kind: "image", name: `omf-sut:${CURRENT}-1`, run_id: CURRENT },
    ];
    expect(await sweepImplementerContainers({ runtime: memory, itemDir, currentRunId: CURRENT })).toBe(2);
    expect(memory.owned.map((resource) => resource.name).sort()).toEqual(
      [
        `omf-author-${EARLIER}-1-1`,
        `omf-implementer-${OTHER_ITEM}-1-1`,
        `omf-sut-${CURRENT}-1-1`,
        `omf-sut:${CURRENT}-1`,
      ].sort(),
    );
  });

  it("also removes an earlier run's implementer container", async () => {
    const itemDir = realTempDir("omf-sweep-item-");
    put(itemDir, `runs/${EARLIER}/audit-1.json`, "{}");
    const memory = new MemoryRuntime();
    memory.owned = [
      { kind: "container", name: `omf-implementer-${EARLIER}-1-1`, run_id: EARLIER },
      { kind: "container", name: `omf-implementer-${CURRENT}-1-1`, run_id: CURRENT },
    ];
    expect(await sweepOrphans({ runtime: memory, itemDir, currentRunId: CURRENT })).toEqual({
      containers: 1,
      images: 0,
      staging: 0,
      skipped: [],
    });
    expect(memory.owned.map((resource) => resource.name)).toEqual([`omf-implementer-${CURRENT}-1-1`]);
  });

  it("also removes an earlier run's implementer-stage directory and keeps the current run's", async () => {
    const itemDir = realTempDir("omf-sweep-item-");
    put(itemDir, `runs/${EARLIER}/implementer-stage/round-1/bundle`, "x");
    put(itemDir, `runs/${EARLIER}/judge/scratch`, "x");
    put(itemDir, `runs/${CURRENT}/implementer-stage/round-1/bundle`, "x");
    const memory = new MemoryRuntime();
    expect(await sweepOrphans({ runtime: memory, itemDir, currentRunId: CURRENT })).toEqual({
      containers: 0,
      images: 0,
      staging: 2,
      skipped: [],
    });
    expect(existsSync(join(itemDir, "runs", EARLIER, "implementer-stage"))).toBe(false);
    expect(existsSync(join(itemDir, "runs", EARLIER, "judge"))).toBe(false);
    expect(existsSync(join(itemDir, "runs", CURRENT, "implementer-stage"))).toBe(true);
  });

  it("skips and reports a labelled container whose name is off the pattern, and still sweeps the rest", async () => {
    const itemDir = realTempDir("omf-sweep-item-");
    put(itemDir, `runs/${EARLIER}/audit-1.json`, "{}");
    const odd = `omf-sut-${EARLIER}-odd name`;
    const memory = new MemoryRuntime();
    memory.owned = [
      { kind: "container", name: odd, run_id: EARLIER },
      { kind: "container", name: `omf-sut-${EARLIER}-1-1`, run_id: EARLIER },
      { kind: "image", name: `omf-sut:${EARLIER}-1`, run_id: EARLIER },
    ];
    // The real runtime refuses a name outside the container name pattern when it builds the removal argv.
    const strict = {
      listOwned: (filter: { run_id: string | null }) => memory.listOwned(filter),
      removeImage: (id: ImageId) => memory.removeImage(id),
      remove: async (handle: ContainerHandle) => {
        assertName(handle.name);
        await memory.remove(handle);
      },
    };
    const swept = await sweepOrphans({ runtime: strict, itemDir, currentRunId: CURRENT });
    expect(swept).toEqual({ containers: 1, images: 1, staging: 0, skipped: [odd] });
    expect(memory.owned.map((resource) => resource.name)).toEqual([odd]);
  });

  it("a SIGKILLed round leaves its containers, and the next run's sweep removes them", async () => {
    const dir = realTempDir("omf-sweep-kill-");
    const log = join(dir, "log");
    const marker = join(dir, "ready");
    const itemDir = join(dir, "item");
    put(itemDir, `runs/${CHILD_RUN}/placeholder`, "x"); // the run directory the killed process owned
    const child = spawn(process.execPath, [CHILD, "tracked", log, marker, join(dir, "judge")], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    await waitForPids(marker, 15_000);
    child.kill("SIGKILL");
    expect(await ended).toEqual({ code: null, signal: "SIGKILL" });
    const text = readFileSync(log, "utf8");
    expect(text).not.toMatch(/remove/); // no handler ran
    const created = text
      .trim()
      .split("\n")
      .filter((line) => line.startsWith("create "))
      .map((line) => line.slice("create ".length));
    expect(created).toHaveLength(2);
    const memory = new MemoryRuntime();
    memory.owned = created.map((name) => ({ kind: "container" as const, name, run_id: CHILD_RUN }));
    const swept = await sweepOrphans({ runtime: memory, itemDir, currentRunId: "r-20261015T000000Z-ffff" });
    expect(swept.containers).toBe(2);
    expect(memory.owned).toEqual([]);
  });
});
