import { describe, expect, it } from "vitest";
import { assessDiffRisk, classifyDiff } from "../../src/audit/diff.js";
import { rawDiff } from "../../src/git/ops.js";
import { classifyRisk } from "../../src/work/risk.js";
import type { RiskAssessment } from "../../src/work/types.js";
import { type GitFixture, gitFixture } from "../helpers/git-fixture.js";

// Spec §4.4, M3e-D11: the audit recomputes the risk from the real diff and can only raise it. A candidate that declared
// `normal` and touched CI ends high; a declaration that was already high is never lowered by a calm diff; no pair of inputs
// gives an effective class below either of them.
const none: { watchedGlobs: string[]; extraGlobs: string[] } = { watchedGlobs: [], extraGlobs: [] };
const normal: RiskAssessment = { class: "normal", rules: [], paths: [] };

async function assess(fx: GitFixture, declared: RiskAssessment, globs = none) {
  const facts = classifyDiff(await rawDiff(fx.quarantine, fx.base, fx.head), [], []);
  return assessDiffRisk(facts, declared, globs);
}

describe("W-risk-only-raises", () => {
  it("a declared-normal item whose diff touches CI ends high with the rule ci", async () => {
    const fx = gitFixture({ "src/a.ts": "1\n", ".github/workflows/ci.yml": "on: push\n" }, { "src/a.ts": "2\n", ".github/workflows/ci.yml": "on: [push, pull_request]\n" });
    const outcome = await assess(fx, normal);
    expect(outcome.effective).toEqual({ class: "high", rules: ["ci"], paths: [".github/workflows/ci.yml"] });
    expect(outcome.raised).toBe(true);
    expect(outcome.recomputed?.paths).toEqual([".github/workflows/ci.yml"]);
  });

  it("a deleted CI file and an added lockfile raise too, because every status counts", async () => {
    const deleted = gitFixture({ "src/a.ts": "1\n", ".github/workflows/ci.yml": "on: push\n" }, { ".github/workflows/ci.yml": null, "src/a.ts": "2\n" });
    expect((await assess(deleted, normal)).effective).toMatchObject({ class: "high", rules: ["ci"] });
    const added = gitFixture({ "src/a.ts": "1\n" }, { "package-lock.json": "{}\n" });
    expect((await assess(added, normal)).effective).toMatchObject({ class: "high", rules: ["lockfile"] });
  });

  it("a declared-high item whose diff touches only src/ stays high and is not reported as raised", async () => {
    const fx = gitFixture({ "src/a.ts": "1\n" }, { "src/a.ts": "2\n" });
    const declared: RiskAssessment = { class: "high", rules: ["auth"], paths: ["src/auth/login.ts"] };
    const outcome = await assess(fx, declared);
    expect(outcome.effective).toEqual(declared);
    expect(outcome.raised).toBe(false);
    expect(outcome.recomputed).toEqual({ class: "normal", rules: [], paths: [] });
  });

  it("a declared-normal item whose diff touches only src/ stays normal", async () => {
    const fx = gitFixture({ "src/a.ts": "1\n" }, { "src/a.ts": "2\n" });
    expect((await assess(fx, normal)).effective).toEqual(normal);
  });

  it("an empty diff keeps the declared risk and reports no recompute", async () => {
    const fx = gitFixture({ "src/a.ts": "1\n" }, { "src/a.ts": "2\n" });
    const declared: RiskAssessment = { class: "high", rules: ["undeclared"], paths: [] };
    const outcome = await assess({ ...fx, base: fx.head }, declared);
    expect(outcome).toEqual({ recomputed: null, effective: declared, raised: false });
  });

  it("the watched-path globs of the locked metrics raise a normal declaration", async () => {
    const fx = gitFixture({ "src/hot/x.ts": "1\n" }, { "src/hot/x.ts": "2\n" });
    const outcome = await assess(fx, normal, { watchedGlobs: ["src/hot/**"], extraGlobs: [] });
    expect(outcome.effective).toMatchObject({ class: "high", rules: ["watched-path"] });
  });

  it("no pair of declared and diff-based assessments gives a lower effective class, and the declared rules are never dropped", () => {
    const declareds: RiskAssessment[] = [normal, { class: "high", rules: ["auth"], paths: ["a"] }, { class: "high", rules: ["undeclared"], paths: [] }];
    const diffs: string[][] = [[], ["src/a.ts"], [".github/workflows/x.yml"], ["src/auth/y.ts", "db/migrations/1.sql"], ["src/[odd].ts"]];
    for (const declared of declareds) {
      for (const paths of diffs) {
        const facts = classifyDiff(paths.map((path) => ({ status: "M" as const, path, old_mode: "100644", new_mode: "100644" })), [], []);
        const { effective } = assessDiffRisk(facts, declared, none);
        if (declared.class === "high") expect(effective.class).toBe("high");
        if (paths.length > 0 && classifyRisk({ declaredPaths: paths, watchedGlobs: [], extraGlobs: [], tracked: [] }).class === "high") expect(effective.class).toBe("high");
        for (const rule of declared.rules) expect(effective.rules).toContain(rule);
      }
    }
  });
});
