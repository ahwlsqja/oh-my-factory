import { describe, expect, it } from "vitest";
import { assessDiffRisk, classifyDiff } from "../../src/audit/diff.js";
import type { RawDiffEntry } from "../../src/git/ops.js";
import type { RiskAssessment } from "../../src/work/types.js";

const entry = (
  status: RawDiffEntry["status"],
  path: string,
  old_mode = "100644",
  new_mode = "100644",
): RawDiffEntry => ({
  status,
  path,
  old_mode: status === "A" ? "000000" : old_mode,
  new_mode: status === "D" ? "000000" : new_mode,
});

describe("classifyDiff", () => {
  it("separates edited tests from added tests (M3e-D10) and lists every touched path", () => {
    const facts = classifyDiff(
      [
        entry("M", "src/a.ts"),
        entry("M", "tests/a.test.ts"),
        entry("D", "tests/old.test.ts"),
        entry("T", "tests/t.test.ts"),
        entry("A", "tests/new.test.ts"),
        entry("A", "src/new.ts"),
      ],
      [],
      [],
    );
    expect(facts).toEqual({
      files: 6,
      empty: false,
      paths: ["src/a.ts", "src/new.ts", "tests/a.test.ts", "tests/new.test.ts", "tests/old.test.ts", "tests/t.test.ts"],
      tests_edited: ["tests/a.test.ts", "tests/old.test.ts", "tests/t.test.ts"],
      tests_added: 1,
      special_entries: 0,
      projections_touched: [],
    });
  });

  it("counts a renamed test as an edit (a delete plus an add) and an added one as an addition", () => {
    const facts = classifyDiff([entry("D", "tests/a.test.ts"), entry("A", "tests/b.test.ts")], [], []);
    expect(facts.tests_edited).toEqual(["tests/a.test.ts"]);
    expect(facts.tests_added).toBe(1);
  });

  it("honours explicit test paths", () => {
    expect(classifyDiff([entry("M", "e2e/flow.ts")], [], []).tests_edited).toEqual([]);
    expect(classifyDiff([entry("M", "e2e/flow.ts")], ["e2e"], []).tests_edited).toEqual(["e2e/flow.ts"]);
  });

  it("counts symlink and gitlink entries by mode, in the old or the new mode", () => {
    const facts = classifyDiff(
      [
        entry("M", "l.txt", "100644", "120000"),
        entry("M", "vendor/lib", "160000", "160000"),
        entry("D", "gone-link", "120000"),
        entry("A", "plain.txt"),
      ],
      [],
      [],
    );
    expect(facts.special_entries).toBe(3);
  });

  it("matches projections case-insensitively and normalised, and only at the listed path", () => {
    const facts = classifyDiff(
      [entry("M", "spec.md"), entry("M", "INTENT.MD"), entry("M", "docs/spec.md"), entry("M", "src/a.ts")],
      [],
      ["spec.md", "./intent.md"],
    );
    expect(facts.projections_touched).toEqual(["INTENT.MD", "spec.md"]);
  });

  it("an empty diff is empty with zero counts", () => {
    expect(classifyDiff([], [], ["spec.md"])).toEqual({
      files: 0,
      empty: true,
      paths: [],
      tests_edited: [],
      tests_added: 0,
      special_entries: 0,
      projections_touched: [],
    });
  });
});

describe("assessDiffRisk", () => {
  const declaredNormal: RiskAssessment = { class: "normal", rules: [], paths: [] };
  const none = { watchedGlobs: [], extraGlobs: [] };
  const facts = (...paths: string[]) =>
    classifyDiff(
      paths.map((path) => entry("M", path)),
      [],
      [],
    );

  it("an empty diff skips the recompute: classifyRisk would say `undeclared` for zero paths, which is no finding about the diff (M3e-D12)", () => {
    const declared: RiskAssessment = { class: "high", rules: ["auth"], paths: ["src/auth/x.ts"] };
    expect(assessDiffRisk(facts(), declared, none)).toEqual({ recomputed: null, effective: declared, raised: false });
  });

  it("recomputes from the paths of the diff and raises a normal declaration", () => {
    const outcome = assessDiffRisk(facts("src/a.ts", ".github/workflows/ci.yml"), declaredNormal, none);
    expect(outcome.recomputed).toEqual({ class: "high", rules: ["ci"], paths: [".github/workflows/ci.yml"] });
    expect(outcome.effective).toEqual({ class: "high", rules: ["ci"], paths: [".github/workflows/ci.yml"] });
    expect(outcome.raised).toBe(true);
  });

  it("a normal diff leaves a normal declaration alone", () => {
    const outcome = assessDiffRisk(facts("src/a.ts"), declaredNormal, none);
    expect(outcome).toEqual({
      recomputed: { class: "normal", rules: [], paths: [] },
      effective: declaredNormal,
      raised: false,
    });
  });

  it("adds a rule to a high declaration and reports it as raised, but never lowers it", () => {
    const declared: RiskAssessment = { class: "high", rules: ["auth"], paths: [] };
    const outcome = assessDiffRisk(facts(".github/workflows/ci.yml"), declared, none);
    expect(outcome.effective.rules).toEqual(["auth", "ci"]);
    expect(outcome.raised).toBe(true);
    expect(assessDiffRisk(facts("src/a.ts"), declared, none)).toMatchObject({ effective: declared, raised: false });
  });

  it("uses the watched and extra globs", () => {
    const outcome = assessDiffRisk(facts("src/secret/x.ts", "docs/y.md"), declaredNormal, {
      watchedGlobs: ["src/secret/**"],
      extraGlobs: ["docs/**"],
    });
    expect(outcome.effective.rules).toEqual(["extra", "watched-path"]);
  });

  it("a glob character in a diff path is a literal character: the real rules still match and the path is listed", () => {
    const outcome = assessDiffRisk(facts(".github/workflows/build[1].yml"), declaredNormal, none);
    expect(outcome.effective).toEqual({ class: "high", rules: ["ci"], paths: [".github/workflows/build[1].yml"] });
    expect(outcome.raised).toBe(true);
  });

  it("Next.js route paths with brackets or parentheses are not a finding", () => {
    expect(
      assessDiffRisk(facts("app/posts/[id]/page.tsx", "app/(group)/x/page.tsx"), declaredNormal, none).effective,
    ).toEqual(declaredNormal);
  });

  it("a backslash or a control character cannot be judged: high, unclassifiable, listed", () => {
    expect(assessDiffRisk(facts("src/a\\b.ts"), declaredNormal, none).effective).toEqual({
      class: "high",
      rules: ["unclassifiable"],
      paths: ["src/a\\b.ts"],
    });
    expect(assessDiffRisk(facts("src/a\nb.ts"), declaredNormal, none).effective).toMatchObject({
      class: "high",
      rules: ["unclassifiable"],
    });
  });
});

describe("assessDiffRisk with the test-weakening check", () => {
  const declaredNormal: RiskAssessment = { class: "normal", rules: [], paths: [] };
  const none = { watchedGlobs: [], extraGlobs: [] };
  const facts = (...paths: string[]) => ({
    files: paths.length,
    empty: false,
    paths,
    tests_edited: [],
    tests_added: 0,
    special_entries: 0,
    projections_touched: [],
  });

  it("an added test file alone is not high when the check ran", () => {
    const outcome = assessDiffRisk(facts("src/a.ts", "tests/new.test.ts"), declaredNormal, none, []);
    expect(outcome.effective).toEqual({ class: "normal", rules: [], paths: [] });
    expect(outcome.raised).toBe(false);
  });

  it("a weakened test is high by the rule test-weakening, listing the path", () => {
    const outcome = assessDiffRisk(facts("src/a.ts", "tests/a.test.ts"), declaredNormal, none, ["tests/a.test.ts"]);
    expect(outcome.effective).toEqual({ class: "high", rules: ["test-weakening"], paths: ["tests/a.test.ts"] });
    expect(outcome.raised).toBe(true);
  });

  it.each([undefined, null])("a missing diff (%s) keeps a test change high by the rule test", (weakening) => {
    const outcome = assessDiffRisk(facts("tests/a.test.ts"), declaredNormal, none, weakening);
    expect(outcome.effective).toEqual({ class: "high", rules: ["test"], paths: ["tests/a.test.ts"] });
  });

  it("other rules still apply when the check ran", () => {
    const outcome = assessDiffRisk(facts(".github/workflows/ci.yml", "tests/a.test.ts"), declaredNormal, none, []);
    expect(outcome.effective.rules).toEqual(["ci"]);
  });

  it("keeps a configured test path high when the weakening check returned null", () => {
    const outcome = assessDiffRisk(facts("e2e/flow.ts"), declaredNormal, { ...none, explicitTestPaths: ["e2e"] }, null);
    expect(outcome.effective.class).toBe("high");
    expect(outcome.effective.rules).toEqual(["test"]);
  });
});
