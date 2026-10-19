import { describe, expect, it } from "vitest";
import {
  type RiskInput,
  DEFAULT_HIGH_RISK,
  TEST_GLOBS,
  classifyLiteralPaths,
  classifyRisk,
  isTestPath,
  raiseRisk,
} from "../../src/work/risk.js";
import type { RiskAssessment } from "../../src/work/types.js";

function input(declaredPaths: string[], extra: Partial<RiskInput> = {}): RiskInput {
  return { declaredPaths, watchedGlobs: [], extraGlobs: [], tracked: [], ...extra };
}

describe("classifyRisk default rules", () => {
  it.each([
    [".github/workflows/ci.yml", "ci"],
    ["src/auth/login.ts", "auth"],
    ["db/migrations/001.sql", "migration"],
    ["AGENTS.md", "goal-factory"],
    ["package-lock.json", "lockfile"],
    ["pkg/pnpm-lock.yaml", "lockfile"],
  ] as const)("%s is high by rule %s", (path, rule) => {
    expect(classifyRisk(input([path]))).toEqual({ class: "high", rules: [rule], paths: [path] });
  });

  it("a declared test path is not high at declaration: there is no diff to weaken yet", () => {
    expect(classifyRisk(input(["tests/a.test.ts"]))).toEqual({ class: "normal", rules: [], paths: [] });
    expect(classifyRisk(input(["tests"], { tracked: ["tests/a.test.ts"] })).class).toBe("normal");
  });

  it("covers every rule in the default table with at least one glob", () => {
    expect(DEFAULT_HIGH_RISK.map((entry) => entry.rule)).toEqual([
      "ci",
      "auth",
      "migration",
      "test",
      "goal-factory",
      "lockfile",
    ]);
    for (const entry of DEFAULT_HIGH_RISK) expect(entry.globs.length).toBeGreaterThan(0);
  });

  it("is normal for an ordinary source file", () => {
    expect(classifyRisk(input(["src/render/button.ts"]))).toEqual({ class: "normal", rules: [], paths: [] });
  });

  it("matches case-insensitively and ignores a leading ./ and a trailing /", () => {
    expect(classifyRisk(input(["./SRC/Auth/Login.ts"])).rules).toEqual(["auth"]);
    expect(classifyRisk(input([".GitHub/Workflows/"])).rules).toEqual(["ci"]);
  });

  it("expands a declared directory case-insensitively over tracked files", () => {
    const tracked = ["src/auth/login.ts", "bench/p95.sh"];
    expect(classifyRisk(input(["SRC"], { tracked })).rules).toEqual(["auth"]);
    expect(classifyRisk(input(["Src/"], { tracked })).class).toBe("high");
    expect(classifyRisk(input(["BENCH"], { tracked, watchedGlobs: ["bench/p95.sh"] })).rules).toEqual(["watched-path"]);
  });

  it("rejects a declared path with a .git segment anywhere", () => {
    expect(classifyRisk(input(["src/.git/config"])).rules).toEqual(["unclassifiable"]);
  });

  it("collects every rule that fires, sorted, and the paths that fired", () => {
    expect(
      classifyRisk(input(["src/render/button.ts", "tests/a.test.ts", "db/migrations/001.sql", "tests/a.test.ts"])),
    ).toEqual({
      class: "high",
      rules: ["migration"],
      paths: ["db/migrations/001.sql"],
    });
  });
});

describe("classifyRisk watched and extra globs", () => {
  it("labels a watched glob without naming anything about the metric", () => {
    const result = classifyRisk(input(["bench/run.sh"], { watchedGlobs: ["bench/**"] }));
    expect(result).toEqual({ class: "high", rules: ["watched-path"], paths: ["bench/run.sh"] });
    expect(JSON.stringify(result)).not.toContain("bench/**");
  });

  it("labels an extra glob", () => {
    expect(classifyRisk(input(["infra/main.tf"], { extraGlobs: ["infra/**"] }))).toEqual({
      class: "high",
      rules: ["extra"],
      paths: ["infra/main.tf"],
    });
  });

  it("leaves a path outside every glob normal", () => {
    expect(classifyRisk(input(["src/ui/a.ts"], { watchedGlobs: ["bench/**"], extraGlobs: ["infra/**"] })).class).toBe(
      "normal",
    );
  });
});

describe("classifyRisk directories", () => {
  it("is high for a directory that holds a tracked high-risk file", () => {
    const tracked = ["src/auth/x.ts", "src/render/button.ts"];
    expect(classifyRisk(input(["src"], { tracked }))).toEqual({ class: "high", rules: ["auth"], paths: ["src"] });
  });

  it("is normal for a directory whose tracked files are all ordinary, or that tracks none", () => {
    expect(classifyRisk(input(["src"], { tracked: ["src/render/button.ts", "srcs/auth/x.ts"] })).class).toBe("normal");
    expect(classifyRisk(input(["src"])).class).toBe("normal");
  });

  it("is high for a directory that is itself under a high-risk glob, tracked or not", () => {
    expect(classifyRisk(input([".github/workflows"])).rules).toEqual(["ci"]);
    expect(classifyRisk(input(["src/auth"])).rules).toEqual(["auth"]);
  });

  it("is high for a new untracked file under a high-risk glob by pattern alone", () => {
    expect(classifyRisk(input(["db/migrations/002_new.sql"], { tracked: ["README.md"] })).rules).toEqual(["migration"]);
  });
});

describe("classifyRisk fail closed", () => {
  it("is high/undeclared for an empty declaration", () => {
    expect(classifyRisk(input([]))).toEqual({ class: "high", rules: ["undeclared"], paths: [] });
  });

  it.each([
    "../x",
    "/etc/passwd",
    ".git/config",
    ".GIT/hooks/pre-commit",
    "src/*.ts",
    "a/../b",
    ".",
    "./",
    "",
    "src\\a.ts",
    "a\nb",
    "src/{a,b}.ts",
  ])("is high/unclassifiable for %j", (path) => {
    expect(classifyRisk(input([path]))).toEqual({ class: "high", rules: ["unclassifiable"], paths: [] });
  });

  it("keeps the other rules when one path is unclassifiable", () => {
    expect(classifyRisk(input(["tests/a.test.ts", "../x"]))).toEqual({
      class: "high",
      rules: ["unclassifiable"],
      paths: [],
    });
  });
});

describe("classifyRisk purity", () => {
  it("gives the same output for the same input and for shuffled path order", () => {
    const declared = ["src/render/button.ts", "tests/a.test.ts", "AGENTS.md", "src"];
    const tracked = ["src/auth/x.ts", "src/render/button.ts", "README.md"];
    const first = classifyRisk(input(declared, { tracked }));
    expect(classifyRisk(input(declared, { tracked }))).toEqual(first);
    expect(classifyRisk(input([...declared].reverse(), { tracked: [...tracked].reverse() }))).toEqual(first);
    expect(first.rules).toEqual(["auth", "goal-factory"]);
  });
});

describe("TEST_GLOBS and isTestPath", () => {
  it("TEST_GLOBS is the test rule of DEFAULT_HIGH_RISK, one source", () => {
    expect(TEST_GLOBS).toEqual(DEFAULT_HIGH_RISK.find((entry) => entry.rule === "test")?.globs);
  });

  it.each([
    ["**/test/**", "test/a.ts"],
    ["**/test/**", "src/test/a.ts"],
    ["**/tests/**", "tests/a.ts"],
    ["**/__tests__/**", "pkg/__tests__/a.ts"],
    ["**/*.test.*", "a.test.ts"],
    ["**/*.spec.*", "x/a.spec.js"],
    ["**/*_test.*", "pkg/a_test.go"],
    ["**/*_spec.*", "a_spec.rb"],
  ])("agrees with the test rule of classifyLiteralPaths for the default glob %s (%s)", (glob, path) => {
    expect(TEST_GLOBS).toContain(glob);
    expect(isTestPath(path)).toBe(true);
    expect(classifyLiteralPaths({ paths: [path], watchedGlobs: [], extraGlobs: [] }).rules).toEqual(["test"]);
  });

  it("covers every default glob with at least one sample above", () => {
    expect(TEST_GLOBS).toHaveLength(7);
  });

  it("is case-insensitive, includes dot paths and ignores ./", () => {
    expect(isTestPath("Tests/A.TS")).toBe(true);
    expect(isTestPath(".hidden/tests/a.ts")).toBe(true);
    expect(isTestPath("./a.test.ts")).toBe(true);
  });

  it("is false for paths that only look like tests", () => {
    for (const path of [
      "latest.js",
      "src/contest/a.ts",
      "docs/testing.md",
      "src/attest.ts",
      "src/test.js",
      "README.md",
      "",
    ]) {
      expect(isTestPath(path), path).toBe(false);
    }
  });

  it("honours explicit entries as a file or as a directory, anchored at the root, and never guesses a glob", () => {
    expect(isTestPath("e2e/a.ts", ["e2e"])).toBe(true);
    expect(isTestPath("e2e", ["./e2e/"])).toBe(true);
    expect(isTestPath("E2E/deep/a.ts", ["e2e"])).toBe(true);
    expect(isTestPath("spec/helper.rb", ["spec/helper.rb"])).toBe(true);
    expect(isTestPath("e2e2/a.ts", ["e2e"])).toBe(false);
    expect(isTestPath("src/e2e/a.ts", ["e2e"])).toBe(false);
    expect(isTestPath("e2e/a.ts", ["e2e/*.ts"])).toBe(false); // a glob in the list is a literal name, not a pattern
    expect(isTestPath("src/a.ts", [""])).toBe(false);
  });
});

describe("raiseRisk", () => {
  const normal: RiskAssessment = { class: "normal", rules: [], paths: [] };
  const highCi: RiskAssessment = { class: "high", rules: ["ci"], paths: [".github/workflows/ci.yml"] };
  const highAuth: RiskAssessment = { class: "high", rules: ["auth"], paths: ["src/auth/login.ts"] };

  it("normal and normal stay normal", () => {
    expect(raiseRisk(normal, normal)).toEqual(normal);
  });

  it("normal declared with a high recompute is high, with the recomputed rules and paths", () => {
    expect(raiseRisk(normal, highCi)).toEqual(highCi);
  });

  it("high declared with a normal recompute stays high and keeps the declared rules", () => {
    expect(raiseRisk(highAuth, normal)).toEqual(highAuth);
    expect(raiseRisk({ class: "high", rules: ["undeclared"], paths: [] }, normal)).toEqual({
      class: "high",
      rules: ["undeclared"],
      paths: [],
    });
  });

  it("keeps rules and paths as a sorted union without duplicates", () => {
    const raised = raiseRisk(
      { class: "high", rules: ["lockfile", "auth"], paths: ["b", "a"] },
      { class: "high", rules: ["auth", "ci"], paths: ["c", "a"] },
    );
    expect(raised).toEqual({ class: "high", rules: ["auth", "ci", "lockfile"], paths: ["a", "b", "c"] });
  });

  it("is idempotent and never returns a lower class than either input", () => {
    const all = [normal, highCi, highAuth, { class: "high" as const, rules: ["undeclared" as const], paths: [] }];
    for (const declared of all) {
      for (const recomputed of all) {
        const once = raiseRisk(declared, recomputed);
        expect(raiseRisk(once, recomputed)).toEqual(once);
        expect(raiseRisk(once, declared)).toEqual(once);
        if (declared.class === "high" || recomputed.class === "high") expect(once.class).toBe("high");
        for (const rule of declared.rules) expect(once.rules).toContain(rule);
      }
    }
  });

  it("does not change its inputs", () => {
    const declared: RiskAssessment = { class: "normal", rules: [], paths: ["x"] };
    raiseRisk(declared, highCi);
    expect(declared).toEqual({ class: "normal", rules: [], paths: ["x"] });
  });
});
