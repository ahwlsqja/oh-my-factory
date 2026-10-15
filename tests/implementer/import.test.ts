import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_IMPORT_COMMITS } from "../../src/implementer/import.js";
import { attemptImport, importCode } from "../helpers/candidate-import.js";
import {
  type CandidateWorldInput,
  appendFastCommits,
  bundleOf,
  gitAs,
  makeCandidateWorld,
} from "../helpers/git-fixture.js";
import { commitAll, gitIn } from "../helpers/tmp.js";
import { put } from "../helpers/ops-fixture.js";

const WORK_ID = "w1";

// Spec §5.4, §7: the shape the host insists on before it trusts anything a container committed.
describe("importBundle", () => {
  it("imports a candidate and returns its root, context commit, head and work commits", async () => {
    const world = makeCandidateWorld({
      workId: WORK_ID,
      work: [
        { files: { "src/app.ts": "export const app = 2;\n" } },
        { files: { "src/b.ts": "export const b = 1;\n" } },
      ],
    });
    const { result, stageDir } = await attemptImport(world);
    if (!result.ok) throw new Error(`import failed: ${result.code}`);
    expect(result.value.root).toBe(world.rootSha);
    expect(result.value.context).toBe(world.contextSha);
    expect(result.value.head).toBe(world.headSha);
    expect(result.value.work.map((entry) => entry.sha)).toEqual(
      gitIn(world.containerRepo, "rev-list", "--reverse", `${world.contextSha}..HEAD`).trim().split("\n"),
    );
    expect(result.value.work[0]?.parents).toEqual([world.contextSha]);
    expect(existsSync(result.value.quarantine.gitDir)).toBe(true);
    expect(existsSync(join(stageDir, "bundle"))).toBe(false);
  });

  it("refuses a root whose tree is not the user's base tree", async () => {
    const world = makeCandidateWorld({ workId: WORK_ID });
    const other = makeCandidateWorld({ workId: WORK_ID, baseFiles: { "other.txt": "x\n" } });
    const { result } = await attemptImport(world, { baseTreeSha: other.baseTreeSha });
    expect(importCode(result)).toBe("root_tree_mismatch");
  });

  const contextCases: ReadonlyArray<readonly [string, Partial<Omit<CandidateWorldInput, "workId">>]> = [
    ["a third file next to the two rendered ones", { extraContextFiles: { ".omf/w1/plan.md": "x\n" } }],
    ["a rendered file whose bytes differ", { containerContext: { spec: "# spec, edited\n" } }],
    ["a rendered file that is executable", { executableSpec: true }],
  ];
  it.each(contextCases)("refuses a context commit with %s", async (_name, overrides) => {
    const world = makeCandidateWorld({ workId: WORK_ID, ...overrides });
    expect(importCode((await attemptImport(world)).result)).toBe("context_mismatch");
  });

  it("refuses a history with a merge commit", async () => {
    const world = makeCandidateWorld({ workId: WORK_ID, work: [{ files: { "a.txt": "a\n" } }] });
    const repo = world.containerRepo;
    gitAs(repo, "checkout", "-q", "-b", "side", world.contextSha);
    put(repo, "side.txt", "s\n");
    commitAll(repo, "side");
    gitAs(repo, "checkout", "-q", "main");
    gitAs(repo, "merge", "-q", "--no-ff", "side", "-m", "merge");
    expect(importCode((await attemptImport(world, { bundle: bundleOf(repo) })).result)).toBe("history_not_linear");
  });

  it("refuses more commits than the cap", async () => {
    const world = makeCandidateWorld({ workId: WORK_ID });
    appendFastCommits(world.containerRepo, MAX_IMPORT_COMMITS);
    expect(importCode((await attemptImport(world, { bundle: bundleOf(world.containerRepo) })).result)).toBe(
      "too_many_commits",
    );
  });
});
