import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAudit } from "../../src/audit/work-audit.js";
import { findTestWeakening } from "../../src/work/test-weakening.js";
import { auditFixture, auditInput } from "../helpers/audit-diff-fixture.js";

// Each probe runs on the output of the audit's own git diff command in a throwaway repository, through the pure check
// and through runAudit (the path that raises the item to high).
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

function realDiff(before: Record<string, string | Buffer>, after: Record<string, string | Buffer | null>): string {
  for (const [path, content] of Object.entries(before)) put(path, content);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD").trim();
  for (const [path, content] of Object.entries(after)) {
    if (content === null) git("rm", "-q", "-f", path);
    else put(path, content);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "head");
  const head = git("rev-parse", "HEAD").trim();
  return git("diff", "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv", base, head);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "omf-weakening-followups-"));
  git("init", "-q");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const audited = async (base: Record<string, string>, head: Record<string, string | null>) =>
  (await runAudit(auditInput(auditFixture({ "src/a.ts": "1\n", ...base }, head)))).risk.effective;

describe("markers on an added line that looks like a comment", () => {
  const cases: Array<[string, string, string, string]> = [
    ["block comment before describe.only", "tests/new.spec.js", "/* focus */ describe.only('a', () => {});\n", "x\n"],
    [
      "block comment before a Go init that exits",
      "pkg/new_test.go",
      "/* x */ func init() { os.Exit(0) }\n",
      "package p\n",
    ],
    [
      "empty block comment before TestMain that exits",
      "pkg/main_test.go",
      "/**/ func TestMain(m *testing.M) { os.Exit(0) }\n",
      "package p\n",
    ],
    ["marker after a U+2028 terminator", "tests/new.spec.js", "// note describe.only('a', () => {});\n", "x\n"],
    ["marker after a CR terminator", "tests/new.spec.js", "// note\rdescribe.only('a', () => {});\n", "x\n"],
  ];

  it.each(cases)("%s is weakening in the pure check", (_name, path, added) => {
    expect(findTestWeakening(realDiff({ "README.md": "x\n" }, { [path]: added }), [])).toEqual([path]);
  });

  it.each(cases)("%s is high through runAudit", async (_name, path, added) => {
    const risk = await audited({}, { [path]: added });
    expect(risk).toEqual({ class: "high", rules: ["test-weakening"], paths: [path] });
  });

  it("a removed comment-looking marker does not offset an added marker", () => {
    const diff = realDiff(
      { "tests/a.spec.js": "// it.only('old', () => {});\n" },
      { "tests/a.spec.js": "/* x */ it.only('new', () => {});\n" },
    );
    expect(findTestWeakening(diff, [])).toEqual(["tests/a.spec.js"]);
  });

  it("a plain comment that mentions no marker stays normal", () => {
    const diff = realDiff({ "README.md": "x\n" }, { "tests/new.spec.js": "// just a note\n/* more */\n" });
    expect(findTestWeakening(diff, [])).toEqual([]);
  });
});

describe("INI semicolon comments", () => {
  it.each([
    [".coveragerc", "[report]\nfail_under = 90\n", "[report]\n; fail_under = 90\n"],
    ["setup.cfg", "[coverage:report]\nfail_under = 90\n", "[coverage:report]\n; fail_under = 90\n"],
    ["tox.ini", "[coverage:report]\nfail_under = 90\n", "[coverage:report]\n;fail_under = 90\n"],
    [".coveragerc", "[report]\nfail_under = 90\n", "[report]\nfail_under = 10 ; was 90\n"],
  ])("%s with a threshold commented out or lowered is weakening", async (path, before, after) => {
    expect(findTestWeakening(realDiff({ [path]: before }, { [path]: after }), [])).toEqual([path]);
    expect(await audited({ [path]: before }, { [path]: after })).toMatchObject({ class: "high" });
  });

  it.each([
    ["pytest.ini", "[pytest]\naddopts = --cov=pkg --cov-fail-under=90\n"],
    ["tox.ini", "[pytest]\naddopts = --cov=pkg --cov-fail-under=90\n"],
    ["setup.cfg", "[tool:pytest]\naddopts = --cov=pkg --cov-fail-under=90\n"],
  ])("%s: an inline ; payload that really lowers the threshold is weakening", async (path, before) => {
    const after = before.replace("--cov-fail-under=90", "--cov-fail-under=95 --junitxml ; --cov-fail-under=10");
    expect(findTestWeakening(realDiff({ [path]: before }, { [path]: after }), [])).toEqual([path]);
    expect(await audited({ [path]: before }, { [path]: after })).toMatchObject({ class: "high" });
  });

  it(".coveragerc: `fail_under = 95 ; fail_under = 10` really lowers the threshold", async () => {
    const before = { ".coveragerc": "[report]\nfail_under = 90\n" };
    const after = { ".coveragerc": "[report]\nfail_under = 95 ; fail_under = 10\n" };
    expect(findTestWeakening(realDiff(before, after), [])).toEqual([".coveragerc"]);
    expect(await audited(before, after)).toMatchObject({ class: "high" });
  });

  it("a trailing ; comment after a raised threshold is still a raise", () => {
    const diff = realDiff({ ".coveragerc": "fail_under = 80\n" }, { ".coveragerc": "fail_under = 90 ; raised\n" });
    expect(findTestWeakening(diff, [])).toEqual([]);
  });
});

describe("deleting a hook or a binary config", () => {
  it.each(["conftest.py", "tests/conftest.py", "a/b/c/conftest.py"])("deleting %s is weakening", async (path) => {
    expect(findTestWeakening(realDiff({ [path]: "import pytest\n" }, { [path]: null }), [])).toEqual([path]);
    expect(await audited({ [path]: "import pytest\n" }, { [path]: null })).toMatchObject({ class: "high" });
  });

  it.each([".coveragerc", "vitest.config.ts", "pytest.ini"])("deleting a binary %s is weakening", async (path) => {
    const content = Buffer.from([0, 1, 2, 3, 0]);
    expect(findTestWeakening(realDiff({ [path]: content }, { [path]: null }), [])).toEqual([path]);
    expect(await audited({ [path]: "a\0b\n" }, { [path]: null })).toMatchObject({ class: "high" });
  });

  it("deleting a text coverage config with no threshold is still read as before", () => {
    const diff = realDiff({ ".coveragerc": "[run]\nbranch = true\n" }, { ".coveragerc": null });
    expect(findTestWeakening(diff, [])).toEqual([]);
  });
});

describe("mode-only changes", () => {
  it("a mode-only change to a test file is normal; to a runner config under a test path or a conftest.py it is weakening", () => {
    const files = {
      "tests/a.test.ts": "expect(1).toBe(1);\n",
      "tests/vitest.config.ts": "export default {};\n",
      "tests/conftest.py": "import pytest\n",
    };
    for (const [path, content] of Object.entries(files)) put(path, content);
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD").trim();
    for (const path of Object.keys(files)) chmodSync(join(repo, path), 0o755);
    git("add", "-A");
    git("-c", "core.fileMode=true", "commit", "-q", "-m", "head");
    const head = git("rev-parse", "HEAD").trim();
    const diff = git("diff", "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv", base, head);
    expect(diff).toContain("old mode 100644");
    expect(findTestWeakening(diff, [])).toEqual(["tests/conftest.py", "tests/vitest.config.ts"]);
  });
});
