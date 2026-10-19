import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findTestWeakening } from "../../src/work/test-weakening.js";

// The diff text is produced by the same git command the audit runs, in a throwaway repository, so the check is
// exercised on real output (binary patches, mode changes) and not on hand-written diffs.
let repo = "";

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: repo,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
    maxBuffer: 16 * 1024 * 1024,
  });
}

function put(path: string, content: string | Buffer): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

/** Commits `before`, applies `after`, and returns the audit's diff text between the two commits. */
function realDiff(before: Record<string, string | Buffer>, after: Record<string, string | Buffer>): string {
  for (const [path, content] of Object.entries(before)) put(path, content);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD").trim();
  for (const [path, content] of Object.entries(after)) put(path, content);
  git("add", "-A");
  git("commit", "-q", "-m", "head");
  const head = git("rev-parse", "HEAD").trim();
  return git("diff", "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv", base, head);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "omf-weakening-"));
  git("init", "-q");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("findTestWeakening on a real git diff", () => {
  it.each(["#", "//"])("does not hide coverage disabling after quoted comment markers: %s", (marker) => {
    const diff = realDiff(
      {
        "tests/vitest.config.ts": `coverage: { thresholds: { lines: 80 }, reportsDirectory: "coverage ${marker} html", enabled: true },\n`,
      },
      {
        "tests/vitest.config.ts": `coverage: { thresholds: { lines: 90 }, reportsDirectory: "coverage ${marker} html", enabled: false },\n`,
      },
    );
    expect(findTestWeakening(diff, [])).toEqual(["tests/vitest.config.ts"]);
  });

  it.each(["#", "//"])("detects lower root thresholds after quoted comment markers: %s", (marker) => {
    const diff = realDiff(
      { "vitest.config.ts": `coverage: { reportsDirectory: "coverage ${marker} html", thresholds: { lines: 90 } },\n` },
      { "vitest.config.ts": `coverage: { reportsDirectory: "coverage ${marker} html", thresholds: { lines: 0 } },\n` },
    );
    expect(findTestWeakening(diff, [])).toEqual(["vitest.config.ts"]);
  });

  it.each([
    ["single quotes", "'coverage # html'"],
    ["escaped double quote", '"coverage \\" // html"'],
    ["escaped single quote", "'coverage \\' # html'"],
    ["template literal", "`coverage // html`"],
  ])("compares the whole config after %s", (_label, directory) => {
    const diff = realDiff(
      {
        "tests/vitest.config.ts": `coverage: { thresholds: { lines: 80 }, reportsDirectory: ${directory}, enabled: true },\n`,
      },
      {
        "tests/vitest.config.ts": `coverage: { thresholds: { lines: 90 }, reportsDirectory: ${directory}, enabled: false },\n`,
      },
    );
    expect(findTestWeakening(diff, [])).toEqual(["tests/vitest.config.ts"]);
  });

  it.each(["#", "//"])("permits a pure threshold raise with a quoted %s marker", (marker) => {
    const diff = realDiff(
      {
        "tests/vitest.config.ts": `coverage: { reportsDirectory: "coverage ${marker} html", thresholds: { lines: 80 } },\n`,
      },
      {
        "tests/vitest.config.ts": `coverage: { reportsDirectory: "coverage ${marker} html", thresholds: { lines: 90 } },\n`,
      },
    );
    expect(findTestWeakening(diff, [])).toEqual([]);
  });

  it("refuses the threshold exemption at an ambiguous regex comment boundary", () => {
    const diff = realDiff(
      { "tests/vitest.config.ts": "{ lines: 80, testNamePattern: / # /, enabled: true }\n" },
      { "tests/vitest.config.ts": "{ lines: 90, testNamePattern: / # /, enabled: false }\n" },
    );
    expect(findTestWeakening(diff, [])).toEqual(["tests/vitest.config.ts"]);
  });

  it("keeps root threshold checks conservative at a regex comment boundary", () => {
    const diff = realDiff(
      { "vitest.config.ts": "{ testNamePattern: / # /, thresholds: { lines: 90 } }\n" },
      { "vitest.config.ts": "{ testNamePattern: / # /, thresholds: { lines: 0 } }\n" },
    );
    expect(findTestWeakening(diff, [])).toEqual(["vitest.config.ts"]);
  });

  it("flags a new spec with this.skip() and a NUL byte: the binary section cannot be read", () => {
    const diff = realDiff({ "README.md": "x\n" }, { "tests/a.spec.ts": "this.skip();\n\u0000\n" });
    expect(diff).toContain("GIT binary patch");
    expect(findTestWeakening(diff, [])).toEqual(["tests/a.spec.ts"]);
  });

  it("flags a lowered .coveragerc that holds a NUL byte", () => {
    const diff = realDiff(
      { ".coveragerc": "[report]\nfail_under = 90\n" },
      { ".coveragerc": "[report]\nfail_under = 50\n\u0000\n" },
    );
    expect(diff).toContain("GIT binary patch");
    expect(findTestWeakening(diff, [])).toEqual([".coveragerc"]);
  });

  it("flags a binary edit of an existing test file", () => {
    const diff = realDiff(
      { "tests/a.test.ts": "expect(1).toBe(1);\n" },
      { "tests/a.test.ts": "expect(1).toBe(1);\n\u0000" },
    );
    expect(findTestWeakening(diff, [])).toEqual(["tests/a.test.ts"]);
  });

  it("does not flag a binary file outside the test and coverage-config paths", () => {
    const diff = realDiff({ "README.md": "x\n" }, { "assets/logo.bin": Buffer.from([0, 1, 2, 3]) });
    expect(findTestWeakening(diff, [])).toEqual([]);
  });

  it("does not flag a mode-only change of a test file", () => {
    const before = { "tests/a.test.ts": "expect(1).toBe(1);\n" };
    put("tests/a.test.ts", before["tests/a.test.ts"]);
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD").trim();
    chmodSync(join(repo, "tests/a.test.ts"), 0o755);
    git("add", "-A");
    git("commit", "-q", "-m", "head");
    const head = git("rev-parse", "HEAD").trim();
    const diff = git("diff", "--binary", "--full-index", "--no-renames", base, head);
    expect(diff).toContain("old mode 100644");
    expect(findTestWeakening(diff, [])).toEqual([]);
  });

  it("flags a root .coveragerc threshold that was commented out", () => {
    const diff = realDiff(
      { ".coveragerc": "[report]\nfail_under = 90\n" },
      { ".coveragerc": "[report]\n# fail_under = 90\n" },
    );
    expect(findTestWeakening(diff, [])).toEqual([".coveragerc"]);
  });

  it("flags a root vitest.config.ts threshold that was commented out", () => {
    const diff = realDiff(
      { "vitest.config.ts": "export default { thresholds: {\n  lines: 90,\n} };\n" },
      { "vitest.config.ts": "export default { thresholds: {\n  // lines: 90,\n} };\n" },
    );
    expect(findTestWeakening(diff, [])).toEqual(["vitest.config.ts"]);
  });

  it("flags a threshold that kept its key but moved into a trailing comment", () => {
    const diff = realDiff({ ".coveragerc": "fail_under = 90\n" }, { ".coveragerc": "fail_under = 10 # was 90\n" });
    expect(findTestWeakening(diff, [])).toEqual([".coveragerc"]);
  });

  it("does not flag a raised threshold that carries a trailing comment", () => {
    const diff = realDiff({ ".coveragerc": "fail_under = 80\n" }, { ".coveragerc": "fail_under = 90 # raised\n" });
    expect(findTestWeakening(diff, [])).toEqual([]);
  });

  it("flags a new pkg/zz_test.go with an init that exits the process", () => {
    const diff = realDiff({ "README.md": "x\n" }, { "pkg/zz_test.go": "package pkg\n\nfunc init() { os.Exit(0) }\n" });
    expect(findTestWeakening(diff, [])).toEqual(["pkg/zz_test.go"]);
  });

  it("flags a new root conftest.py with collect_ignore_glob", () => {
    const diff = realDiff({ "README.md": "x\n" }, { "conftest.py": 'collect_ignore_glob = ["tests/*"]\n' });
    expect(findTestWeakening(diff, [])).toEqual(["conftest.py"]);
  });
});
