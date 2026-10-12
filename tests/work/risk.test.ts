import { describe, expect, it } from "vitest";
import { type RiskInput, DEFAULT_HIGH_RISK, classifyRisk } from "../../src/work/risk.js";

function input(declaredPaths: string[], extra: Partial<RiskInput> = {}): RiskInput {
  return { declaredPaths, watchedGlobs: [], extraGlobs: [], tracked: [], ...extra };
}

describe("classifyRisk default rules", () => {
  it.each([
    [".github/workflows/ci.yml", "ci"],
    ["src/auth/login.ts", "auth"],
    ["db/migrations/001.sql", "migration"],
    ["tests/a.test.ts", "test"],
    ["AGENTS.md", "goal-factory"],
    ["package-lock.json", "lockfile"],
    ["pkg/pnpm-lock.yaml", "lockfile"],
  ] as const)("%s is high by rule %s", (path, rule) => {
    expect(classifyRisk(input([path]))).toEqual({ class: "high", rules: [rule], paths: [path] });
  });

  it("covers every rule in the default table with at least one glob", () => {
    expect(DEFAULT_HIGH_RISK.map((entry) => entry.rule)).toEqual(["ci", "auth", "migration", "test", "goal-factory", "lockfile"]);
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
    expect(classifyRisk(input(["src/render/button.ts", "tests/a.test.ts", "db/migrations/001.sql", "tests/a.test.ts"]))).toEqual({
      class: "high",
      rules: ["migration", "test"],
      paths: ["db/migrations/001.sql", "tests/a.test.ts"],
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
    expect(classifyRisk(input(["src/ui/a.ts"], { watchedGlobs: ["bench/**"], extraGlobs: ["infra/**"] })).class).toBe("normal");
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

  it.each(["../x", "/etc/passwd", ".git/config", ".GIT/hooks/pre-commit", "src/*.ts", "a/../b", ".", "./", "", "src\\a.ts", "a\nb", "src/{a,b}.ts"])(
    "is high/unclassifiable for %j",
    (path) => {
      expect(classifyRisk(input([path]))).toEqual({ class: "high", rules: ["unclassifiable"], paths: [] });
    },
  );

  it("keeps the other rules when one path is unclassifiable", () => {
    expect(classifyRisk(input(["tests/a.test.ts", "../x"]))).toEqual({ class: "high", rules: ["test", "unclassifiable"], paths: ["tests/a.test.ts"] });
  });
});

describe("classifyRisk purity", () => {
  it("gives the same output for the same input and for shuffled path order", () => {
    const declared = ["src/render/button.ts", "tests/a.test.ts", "AGENTS.md", "src"];
    const tracked = ["src/auth/x.ts", "src/render/button.ts", "README.md"];
    const first = classifyRisk(input(declared, { tracked }));
    expect(classifyRisk(input(declared, { tracked }))).toEqual(first);
    expect(classifyRisk(input([...declared].reverse(), { tracked: [...tracked].reverse() }))).toEqual(first);
    expect(first.rules).toEqual(["auth", "goal-factory", "test"]);
  });
});
