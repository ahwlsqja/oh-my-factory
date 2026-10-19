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

type Case = [name: string, path: string, before: string | null, after: string | null];

const weakening: Case[] = [
  [
    ".coveragerc fail_under moved to [html]",
    ".coveragerc",
    "[report]\nfail_under = 90\nshow_missing = True\n[html]\ndirectory = h\n",
    "[report]\nshow_missing = True\n[html]\nfail_under = 90\ndirectory = h\n",
  ],
  [
    "pyproject fail_under moved to html table",
    "pyproject.toml",
    '[tool.coverage.report]\nfail_under = 90\n\n[tool.coverage.html]\ndirectory = "h"\n',
    '[tool.coverage.report]\n\n[tool.coverage.html]\nfail_under = 90\ndirectory = "h"\n',
  ],
  [
    "INI re-indent under exclude_lines",
    ".coveragerc",
    "[report]\nexclude_lines =\n    pragma\nfail_under = 90\n",
    "[report]\nexclude_lines =\n    pragma\n    fail_under = 90\n",
  ],
  ["U+00A0 before the key", ".coveragerc", "[report]\nfail_under = 90\n", "[report]\n\u00a0fail_under = 90\n"],
  ["YAML re-indent of target", "codecov.yml", "coverage:\n  target: 80%\n", "coverage:\n    target: 80%\n"],
  ["YAML target:90% with no space", "codecov.yml", "coverage:\n  target: 80%\n", "coverage:\n  target:90%\n"],
  ["pyproject fail_under -> FAIL_UNDER", "pyproject.toml", "fail_under = 90\n", "FAIL_UNDER = 95\n"],
  ["codecov threshold 1% -> 50%", "codecov.yml", "coverage:\n  threshold: 1%\n", "coverage:\n  threshold: 50%\n"],
  ["added empty pytest.ini", "pytest.ini", null, ""],
  ["added empty .coveragerc", ".coveragerc", null, ""],
  ["deleted empty pytest.ini", "pytest.ini", "", null],
  ["deleted empty .coveragerc", ".coveragerc", "", null],
  ["added empty .pytest.ini", ".pytest.ini", null, ""],
  ["added empty pytest.toml", "pytest.toml", null, ""],
  ["added empty .pytest.toml", ".pytest.toml", null, ""],
  ["added empty extensionless .nycrc", ".nycrc", null, ""],
  ["edited extensionless .mocharc", ".mocharc", "retries: 1\n", "retries: 0\n"],
];

const controls: Case[] = [
  [".coveragerc raise", ".coveragerc", "[report]\nfail_under = 90\n", "[report]\nfail_under = 95\n"],
  [
    "pyproject raise",
    "pyproject.toml",
    "[tool.coverage.report]\nfail_under = 90\n",
    "[tool.coverage.report]\nfail_under = 95\n",
  ],
  ["codecov target raise", "codecov.yml", "coverage:\n  target: 80%\n", "coverage:\n  target: 90%\n"],
];

function diffOf(path: string, before: string | null, after: string | null): string {
  // A "README.md" base keeps the first commit non-empty when the path is added.
  return realDiff({ "README.md": "x\n", ...(before === null ? {} : { [path]: before }) }, { [path]: after });
}

describe("contiguous change blocks and byte-exact pairs", () => {
  it.each(weakening)("%s is weakening in the pure check", (_name, path, before, after) => {
    expect(findTestWeakening(diffOf(path, before, after), [])).toEqual([path]);
  });

  it.each(weakening)("%s is high through runAudit", async (_name, path, before, after) => {
    const risk = await audited(before === null ? {} : { [path]: before }, { [path]: after });
    expect(risk).toEqual({ class: "high", rules: ["test-weakening"], paths: [path] });
  });

  it.each(controls)("%s stays normal", async (_name, path, before, after) => {
    expect(findTestWeakening(diffOf(path, before, after), [])).toEqual([]);
    expect((await audited({ [path]: before ?? "" }, { [path]: after })).class).toBe("normal");
  });

  it("a same-path mode change on a root config keeps the old rule", () => {
    put("pytest.ini", "");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD").trim();
    chmodSync(join(repo, "pytest.ini"), 0o755);
    git("add", "-A");
    git("commit", "-q", "-m", "head");
    const head = git("rev-parse", "HEAD").trim();
    const diff = git("diff", "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv", base, head);
    expect(findTestWeakening(diff, [])).toEqual([]);
  });
});
