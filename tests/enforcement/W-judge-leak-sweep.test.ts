import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sweepOrphans } from "../../src/judge/state.js";
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
    expect(swept).toEqual({ containers: 2, images: 1, staging: 1 });
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
    });
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
