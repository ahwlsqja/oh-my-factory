import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createMarkdownStore } from "../../src/adapters/state-markdown.js";
import { workIdOf } from "../../src/work/fingerprint.js";
import { runChild } from "../helpers/child.js";
import { makeTempDir } from "../helpers/tmp.js";
import { T0, makeNewItem } from "../helpers/work.js";

const STORE_MODULE = resolve("dist/adapters/state-markdown.js");

/** Child: creates the same work item through the store and prints whether it was the creator. */
const CREATOR = `
const { createMarkdownStore } = await import(process.argv[1]);
const [projectDir, inputJson] = process.argv.slice(2);
const result = createMarkdownStore(projectDir).createWorkItem(JSON.parse(inputJson), new Date("2026-10-12T10:00:00.000Z"));
process.stdout.write(result.created ? "created" : "exists");
`;

/** Child: applies one W verb or a veto to an existing item and prints whether the store accepted it. */
const WRITER = `
const { createMarkdownStore } = await import(process.argv[1]);
const [projectDir, workId, verb] = process.argv.slice(2);
const store = createMarkdownStore(projectDir);
const now = new Date("2026-10-12T12:00:00.000Z");
try {
  if (verb === "submit") store.submitWorkItemForReview(workId, now);
  else store.vetoWorkItem(workId, "human:dev", "stop", now);
  process.stdout.write("ok");
} catch {
  process.stdout.write("refused");
}
`;

describe("state-markdown across processes", () => {
  it("two processes racing to create the same work item create exactly one", async () => {
    const projectDir = makeTempDir();
    const input = makeNewItem({ title: "Cache the render path" });
    const runs = await Promise.all(
      [1, 2, 3, 4].map(() => runChild(CREATOR, [STORE_MODULE, projectDir, JSON.stringify(input)])),
    );
    expect(runs.map((run) => run.code)).toEqual([0, 0, 0, 0]);
    expect(runs.filter((run) => run.out === "created")).toHaveLength(1);
    expect(runs.filter((run) => run.out === "exists")).toHaveLength(3);
    const workId = workIdOf(input.fingerprint);
    const items = createMarkdownStore(projectDir).fetchAllWorkItems("g-fast");
    expect(items.map((item) => item.front.work_id)).toEqual([workId]);
    expect(items[0]?.front.created_at).toBe(T0.toISOString());
    const dir = join(projectDir, "goals", "g-fast", "work", workId);
    expect(readdirSync(dir).sort()).toEqual(["intent.md", "item.md"]);
    expect(existsSync(join(dir, "item.md"))).toBe(true);
  });

  it("serialises a veto against concurrent submits: the veto always lands and item.md is never torn", async () => {
    const projectDir = makeTempDir();
    const input = makeNewItem({ title: "Cache the render path" });
    const workId = workIdOf(input.fingerprint);
    const store = createMarkdownStore(projectDir);
    store.createWorkItem(input, T0);
    store.startWorkItem(workId, T0);
    const runs = await Promise.all(
      ["submit", "veto", "submit", "veto"].map((verb) => runChild(WRITER, [STORE_MODULE, projectDir, workId, verb])),
    );
    expect(runs.map((run) => run.code)).toEqual([0, 0, 0, 0]);
    // A veto is legal from in_progress and from awaiting_review, so exactly one veto wins whatever the order;
    // a submit that comes after the veto is refused, and a second submit is refused after the first.
    expect([runs[1]?.out, runs[3]?.out].sort()).toEqual(["ok", "refused"]);
    expect([runs[0], runs[2]].filter((run) => run?.out === "ok").length).toBeLessThanOrEqual(1);
    expect(store.malformedItems("g-fast")).toEqual([]);
    expect(store.fetchWorkItemsByIds([workId])[0]?.front.state).toBe("vetoed");
    const dir = join(projectDir, "goals", "g-fast", "work", workId);
    expect(readdirSync(dir).sort()).toEqual(["intent.md", "item.md"]);
  });
});
