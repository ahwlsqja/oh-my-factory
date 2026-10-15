import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runDecideResolve } from "../../src/cli/decide.js";
import { gitEnv } from "../../src/core/paths.js";
import { specFile } from "../../src/decision/spec-md.js";
import {
  buildContextFiles,
  contextPaths,
  contextTar,
  explicitTestPathsFor,
  gitBlobSha1,
  omfDir,
  projectionPathsFor,
} from "../../src/implementer/context-files.js";
import type { WorkItem } from "../../src/work/types.js";
import { CANARY } from "../helpers/canary.js";
import {
  type DecisionFixture,
  HUMAN,
  addOpen,
  closeInterface,
  expectedSpec,
  relockTarget,
  resolveOpen,
  setupDecisionItem,
} from "../helpers/decision-fixture.js";
import { readTar } from "../helpers/tar-read.js";
import { makeTempDir } from "../helpers/tmp.js";

const ID = "w-0123456789ab";

/** An item with its interface and one more decision resolved: what the station sees when S3 starts. */
function readyItem(): DecisionFixture {
  const f = setupDecisionItem();
  closeInterface(f);
  addOpen(f, "d-cache");
  resolveOpen(f, "d-cache");
  return f;
}

const build = (f: DecisionFixture, item: WorkItem = f.item) =>
  buildContextFiles({ location: f.fx.location, item, events: f.fx.ledger.readVerified() });

/** The same item with one intent field replaced. */
const withProblem = (item: WorkItem, problem: string): WorkItem => ({
  ...item,
  intent: { ...item.intent, candidate: { ...item.intent.candidate, problem } },
});

describe("buildContextFiles", () => {
  it("renders the spec from the folded ledger and never reads the host spec.md", () => {
    const f = readyItem();
    const first = build(f);
    if (!first.ok) throw new Error(`unexpected ${first.code}`);
    expect(first.files.spec).toBe(expectedSpec(f));
    expect(first.files.spec).toContain("d-cache");
    writeFileSync(specFile(f.item.dir), "FORGED SPEC\n");
    expect(build(f)).toEqual(first);
  });

  it("withholds a decision that a goal re-lock made leak, as the spec projection does", () => {
    const f = setupDecisionItem();
    closeInterface(f);
    addOpen(f, "d-cache");
    const resolution = { choice: "Keep 2500 entries", rationale: "That is the size callers use.", rejected: [] };
    runDecideResolve(f.fx.location, f.workId, "d-cache", resolution, HUMAN);
    relockTarget(f, 2500);
    const built = build(f);
    if (!built.ok) throw new Error(`unexpected ${built.code}`);
    expect(built.files.spec).not.toContain("2500");
    expect(built.files.spec).toMatch(/record withheld \(leak\) #\d+/);
  });

  it("builds intent.md without its front matter, and refuses an intent that leaks under the current lock", () => {
    const f = readyItem();
    const built = build(f);
    if (!built.ok) throw new Error(`unexpected ${built.code}`);
    expect(built.files.intent).toContain("# Intent: Cache the render path");
    expect(built.files.intent.startsWith("---")).toBe(false);
    for (const hidden of [f.item.front.fingerprint, f.workId, f.fx.goalId, f.item.intent.candidate.rationale]) {
      expect(built.files.intent).not.toContain(hidden);
    }
    for (const problem of [`Lower ${CANARY.metricId} across the page.`, `Stay under ${CANARY.target} ms.`]) {
      expect(build(f, withProblem(f.item, problem)), problem).toEqual({ ok: false, code: "intent_leak" });
    }
    relockTarget(f, 2500);
    expect(build(f, withProblem(f.item, "Keep 2500 entries."))).toEqual({ ok: false, code: "intent_leak" });
  });
});

describe("per-item paths, the context tarball and the helpers beside them", () => {
  it("puts both files under a per-item directory, refuses an id that could leave it, and tars exactly two 0644 files", () => {
    expect(omfDir(ID)).toBe(`.omf/${ID}`);
    expect(contextPaths(ID)).toEqual({ spec: `.omf/${ID}/spec.md`, intent: `.omf/${ID}/intent.md` });
    expect(projectionPathsFor(ID)).toEqual([`.omf/${ID}/spec.md`, `.omf/${ID}/intent.md`]);
    for (const bad of ["", ".", "..", "../x", "a/b", "a b", "x".repeat(65)]) {
      expect(() => contextPaths(bad), JSON.stringify(bad)).toThrow("work id must match");
    }
    const items = readTar(contextTar(ID, { spec: "S\n", intent: "I\n" }));
    expect(items.map((item) => [item.path, item.type, item.mode, item.data.toString("utf8")])).toEqual([
      [`.omf/${ID}/spec.md`, "file", 0o644, "S\n"],
      [`.omf/${ID}/intent.md`, "file", 0o644, "I\n"],
    ]);
  });

  it("gitBlobSha1 equals git hash-object, and explicitTestPathsFor returns only tracked files the command names", () => {
    const cwd = makeTempDir("omf-hash-");
    for (const bytes of [Buffer.from("hello\n"), Buffer.from([0, 255, 10, 13]), Buffer.alloc(0)]) {
      const args = ["hash-object", "--no-filters", "--stdin"];
      const expected = execFileSync("git", args, { cwd, input: bytes, env: gitEnv(), encoding: "utf8" }).trim();
      expect(gitBlobSha1(bytes)).toBe(expected);
    }
    const tracked = ["tests/a.test.mjs", "src/x.ts", "package.json"];
    const named = ["node", "--test", "./tests/a.test.mjs", "tests/missing.test.mjs"];
    expect(explicitTestPathsFor(named, tracked)).toEqual(["tests/a.test.mjs"]);
    expect(explicitTestPathsFor(["node", "--test", "tests"], tracked), "a directory is not expanded").toEqual([]);
  });
});
