import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMarkdownStore, findWorkItem, workItemDir } from "../../src/adapters/state-markdown.js";
import { claimItem, releaseItem } from "../../src/work/claim.js";
import { workIdOf } from "../../src/work/fingerprint.js";
import { parseWorkItem, renderWorkItem } from "../../src/work/work-item.js";
import { runStateStoreContract } from "../helpers/store-contract.js";
import { makeTempDir } from "../helpers/tmp.js";
import { HIGH_RISK, T0, T1, makeNewItem, rewriteItem } from "../helpers/work.js";

runStateStoreContract("state-markdown", () => createMarkdownStore(makeTempDir("omf-store-")));

const mode = (path: string): string => (statSync(path).mode & 0o777).toString(8);

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? allFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe("state-markdown files", () => {
  it("writes item.md and intent.md at 0600 in a 0700 directory under the goal", () => {
    const projectDir = makeTempDir("omf-store-");
    const input = makeNewItem();
    const result = createMarkdownStore(projectDir).createWorkItem(input, T0);
    const dir = workItemDir(projectDir, "g-fast", workIdOf(input.fingerprint));
    expect(result.created && result.item.dir).toBe(dir);
    expect(mode(dir)).toBe("700");
    expect(mode(join(dir, "item.md"))).toBe("600");
    expect(mode(join(dir, "intent.md"))).toBe("600");
    // item.lock is released, and no temp file survives the atomic writes.
    expect(readdirSync(dir).sort()).toEqual(["intent.md", "item.md"]);
  });

  it("reads back exactly what it wrote, including the intent", () => {
    const projectDir = makeTempDir("omf-store-");
    const store = createMarkdownStore(projectDir);
    const input = makeNewItem({ title: "Update the CI workflow", paths: [".github/workflows/ci.yml"], risk: HIGH_RISK });
    const created = store.createWorkItem(input, T0);
    if (!created.created) throw new Error("expected a new item");
    const [read] = store.fetchWorkItemsByIds([created.item.front.work_id]);
    expect(read?.front).toEqual(created.item.front);
    expect(read?.intent.candidate).toEqual(input.candidate);
    expect(findWorkItem(projectDir, created.item.front.work_id)?.front).toEqual(created.item.front);
    expect(findWorkItem(projectDir, "w-ffffffffffff")).toBeNull();
  });

  it("keeps the progress region across a rewrite", () => {
    const projectDir = makeTempDir("omf-store-");
    const store = createMarkdownStore(projectDir);
    const input = makeNewItem({ risk: HIGH_RISK });
    const created = store.createWorkItem(input, T0);
    if (!created.created) throw new Error("expected a new item");
    writeFileSync(join(created.item.dir, "item.md"), renderWorkItem(created.item.front, "step 1 done"));
    store.approveWorkItem(created.item.front.work_id, "human:dev", T1);
    const text = readFileSync(join(created.item.dir, "item.md"), "utf8");
    expect(parseWorkItem(text).progress).toBe("step 1 done\n");
  });

  it("writes no value, threshold or query key into any file (spec §4.6)", () => {
    const projectDir = makeTempDir("omf-store-");
    const store = createMarkdownStore(projectDir);
    store.createWorkItem(makeNewItem({ title: "Cache the render path" }), T0);
    store.createWorkItem(makeNewItem({ title: "Update the CI workflow", risk: HIGH_RISK }), T0);
    const files = allFiles(join(projectDir, "goals"));
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const file of files) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/^\s*(value|threshold|query)\s*:/im);
    }
  });

  it("completes a create that was interrupted after intent.md, and does not call a half-made directory an item", () => {
    const projectDir = makeTempDir("omf-store-");
    const store = createMarkdownStore(projectDir);
    const input = makeNewItem();
    const dir = workItemDir(projectDir, "g-fast", workIdOf(input.fingerprint));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "intent.md"), "half");
    expect(store.fetchAllWorkItems("g-fast")).toEqual([]);
    expect(store.malformedItems("g-fast")).toEqual([]);
    expect(store.createWorkItem(input, T0).created).toBe(true);
    expect(store.fetchAllWorkItems("g-fast")).toHaveLength(1);
  });

  it("skips an unparseable item.md in the state fetch, reports it in malformedItems and never throws for it", () => {
    const projectDir = makeTempDir("omf-store-");
    const store = createMarkdownStore(projectDir);
    store.createWorkItem(makeNewItem({ title: "Cache the render path" }), T0);
    const junk = workItemDir(projectDir, "g-fast", "w-0123456789ab");
    mkdirSync(junk, { recursive: true });
    writeFileSync(join(junk, "item.md"), "not a work item");
    expect(store.fetchWorkItemsByStates("g-fast", ["ready"])).toHaveLength(1);
    expect(store.fetchAllWorkItems("g-fast")).toHaveLength(1);
    const malformed = store.malformedItems("g-fast");
    expect(malformed).toHaveLength(1);
    expect(malformed[0]).toMatchObject({ dir: junk, work_id: "w-0123456789ab" });
    expect(malformed[0]?.reason).toMatch(/^item\.md unreadable/);
    expect(() => store.fetchWorkItemsByIds(["w-0123456789ab"])).toThrow(/malformed/);
    expect(() => store.vetoWorkItem("w-0123456789ab", "human:dev", "no", T1)).toThrow(/malformed/);
  });

  it("calls an item malformed when its file names another id or goal than its directory", () => {
    const projectDir = makeTempDir("omf-store-");
    const store = createMarkdownStore(projectDir);
    const created = store.createWorkItem(makeNewItem(), T0);
    if (!created.created) throw new Error("expected a new item");
    rewriteItem(created.item, { work_id: "w-aaaaaaaaaaaa" });
    expect(store.malformedItems("g-fast")[0]?.reason).toBe("item.md work_id does not match its directory");
    rewriteItem(created.item, { goal_id: "g-other" });
    expect(store.malformedItems("g-fast")[0]?.reason).toBe("item.md goal_id does not match its goal directory");
  });

  it("calls an item malformed when intent.md is missing", () => {
    const projectDir = makeTempDir("omf-store-");
    const store = createMarkdownStore(projectDir);
    const created = store.createWorkItem(makeNewItem(), T0);
    if (!created.created) throw new Error("expected a new item");
    writeFileSync(join(created.item.dir, "intent.md"), "garbage");
    expect(store.malformedItems("g-fast")[0]?.reason).toMatch(/^intent\.md unreadable/);
  });

  it("answers an empty state list without touching the disk", () => {
    // A path under a regular file fails every directory read with ENOTDIR, so only a read that never happens returns [].
    const notADirectory = join(makeTempDir("omf-store-"), "file");
    writeFileSync(notADirectory, "x");
    const store = createMarkdownStore(notADirectory);
    expect(store.fetchWorkItemsByStates("g-fast", [])).toEqual([]);
    expect(() => store.fetchWorkItemsByStates("g-fast", ["ready"])).toThrow();
  });

  it("rejects a goal id or work id that could leave the work directory", () => {
    const store = createMarkdownStore(makeTempDir("omf-store-"));
    expect(() => store.fetchAllWorkItems("../escape")).toThrow(/invalid goal id/);
    expect(() => store.fetchWorkItemsByIds(["../../etc"])).toThrow(/invalid work id/);
    expect(() => workItemDir("/p", "g-fast", "w-12")).toThrow(/invalid work id/);
  });
});

describe("state-markdown from every open state, and under a claim", () => {
  it("vetoes and cancels from in_progress and awaiting_review", () => {
    const projectDir = makeTempDir("omf-store-");
    const store = createMarkdownStore(projectDir);
    for (const [title, state, verb] of [
      ["Cache the render path", "in_progress", "veto"],
      ["Add a retry wrapper", "in_progress", "cancel"],
      ["Split the parser module", "awaiting_review", "veto"],
      ["Trim the startup path", "awaiting_review", "cancel"],
    ] as const) {
      const created = store.createWorkItem(makeNewItem({ title }), T0);
      if (!created.created) throw new Error("expected a new item");
      rewriteItem(created.item, { state });
      const id = created.item.front.work_id;
      const after =
        verb === "veto" ? store.vetoWorkItem(id, "human:dev", "stop", T1) : store.cancelWorkItem(id, "human:dev", T1);
      expect(after.front.state, `${state} ${verb}`).toBe(verb === "veto" ? "vetoed" : "cancelled");
    }
  });

  it("lets every write verb run while this process holds claim.lock, and veto and cancel under a claim", () => {
    const projectDir = makeTempDir("omf-store-");
    const store = createMarkdownStore(projectDir);
    const gated = store.createWorkItem(makeNewItem({ title: "Update the CI workflow", risk: HIGH_RISK }), T0);
    const other = store.createWorkItem(makeNewItem({ title: "Cache the render path" }), T0);
    const third = store.createWorkItem(makeNewItem({ title: "Add a retry wrapper" }), T0);
    if (!gated.created || !other.created || !third.created) throw new Error("expected new items");
    claimItem(gated.item.dir);
    claimItem(other.item.dir);
    claimItem(third.item.dir);
    expect(store.approveWorkItem(gated.item.front.work_id, "human:dev", T1).front.state).toBe("ready");
    expect(store.vetoWorkItem(other.item.front.work_id, "human:dev", "stop", T1).front.state).toBe("vetoed");
    expect(store.cancelWorkItem(third.item.front.work_id, "omf", T1).front.state).toBe("cancelled");
    expect(store.createWorkItem(makeNewItem({ title: "Cache the render path" }), T1).created).toBe(false);
    for (const item of [gated.item, other.item, third.item]) releaseItem(item.dir);
  });
});

describe("state-markdown W verbs", () => {
  it("writes the marker into the progress region at 0600, leaves no lock file and keeps it across later verbs", () => {
    const projectDir = makeTempDir("omf-store-");
    const store = createMarkdownStore(projectDir);
    const input = makeNewItem();
    const workId = workIdOf(input.fingerprint);
    store.createWorkItem(input, T0);
    store.startWorkItem(workId, T1);
    store.setProgressMarker(workId, "S3 working", T1);
    const dir = workItemDir(projectDir, "g-fast", workId);
    expect(parseWorkItem(readFileSync(join(dir, "item.md"), "utf8")).progress).toBe("S3 working\n");
    expect(mode(join(dir, "item.md"))).toBe("600");
    expect(readdirSync(dir).sort()).toEqual(["intent.md", "item.md"]);
    store.submitWorkItemForReview(workId, T1);
    expect(parseWorkItem(readFileSync(join(dir, "item.md"), "utf8")).progress).toBe("S3 working\n");
  });

  it("changes nothing on disk when a verb is refused", () => {
    const projectDir = makeTempDir("omf-store-");
    const store = createMarkdownStore(projectDir);
    const input = makeNewItem();
    const workId = workIdOf(input.fingerprint);
    store.createWorkItem(input, T0);
    const file = join(workItemDir(projectDir, "g-fast", workId), "item.md");
    const before = readFileSync(file, "utf8");
    expect(() => store.submitWorkItemForReview(workId, T1)).toThrow(/only in_progress/);
    expect(() => store.setProgressMarker(workId, "S3 working", T1)).toThrow(/only in_progress/);
    expect(() => store.repairWorkItem(workId, "failed", T1)).toThrow(/only in_progress/);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});
