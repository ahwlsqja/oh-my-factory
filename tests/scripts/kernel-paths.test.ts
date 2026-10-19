import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { commitAll, gitIn, makeGitRepo, makeTempDir } from "../helpers/tmp.js";

const SCRIPT = fileURLToPath(new URL("../../scripts/kernel-paths.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const LIST_FILE = join(ROOT, "docs/maintainers/kernel-paths.txt");
const NOTICE = "kernel paths touched: the owner merges this after reading the diff; agents do not merge it";

const { parseList, matchKernelPaths, DEFAULT_KERNEL_PATHS, KERNEL_NOTICE } = (await import(SCRIPT)) as {
  parseList: (text: string) => string[];
  matchKernelPaths: (files: string[], patterns: string[]) => { file: string; pattern: string }[];
  DEFAULT_KERNEL_PATHS: string[];
  KERNEL_NOTICE: string;
};

function write(repo: string, rel: string, text: string): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), text);
}

const head = (repo: string): string => gitIn(repo, "rev-parse", "HEAD").trim();

/** base: a kernel file, a plain file; head: the kernel file renamed out of the kernel, a doc added, a workflow added. */
function renamedRepo(): { repo: string; base: string; head: string } {
  const repo = makeGitRepo();
  write(repo, "src/decision/a.ts", "export const a = 1;\n");
  write(repo, "lib/b.ts", "export const b = 1;\n");
  commitAll(repo, "base");
  const base = head(repo);
  mkdirSync(join(repo, "src/misc"), { recursive: true });
  gitIn(repo, "mv", "src/decision/a.ts", "src/misc/a.ts");
  write(repo, "docs/x.md", "# x\n");
  write(repo, ".github/workflows/ci.yml", "name: ci\n");
  commitAll(repo, "head");
  return { repo, base, head: head(repo) };
}

const report = (args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });

describe("parseList", () => {
  it("keeps one pattern per line and ignores comments, blank lines and surrounding space", () => {
    expect(parseList("# kernel\n\n  src/decision/**  \nschemas/**\r\n#x\n")).toEqual(["src/decision/**", "schemas/**"]);
  });

  it.each([
    ["/etc/passwd", "repository-relative"],
    ["../outside/**", "repository-relative"],
    ["src/../x.ts", "repository-relative"],
    ["C:\\x", "repository-relative"],
    ["C:/x", "repository-relative"],
    ["C:x", "repository-relative"],
    ["z:", "repository-relative"],
    ["src\\x.ts", "repository-relative"],
    ["src/{a,b}.ts", "does not support"],
    ["!src/a.ts", "does not support"],
    ["src/[ab].ts", "does not support"],
    ["src/a].ts", "does not support"],
    ["src/(a).ts", "does not support"],
    ["src/a).ts", "does not support"],
    ["src/a}.ts", "does not support"],
  ])("refuses %j with the line number", (line, part) => {
    expect(() => parseList(`ok/**\n${line}\n`)).toThrow(`kernel-paths: line 2`);
    expect(() => parseList(`${line}\n`)).toThrow(part);
  });
});

describe("matchKernelPaths", () => {
  const hits = (file: string, pattern: string): boolean => matchKernelPaths([file], [pattern]).length === 1;

  it.each([
    ["src/decision/a.ts", "src/decision/**", true],
    ["src/decision/deep/er/a.ts", "src/decision/**", true],
    ["src/decisions/a.ts", "src/decision/**", false],
    ["src/decision/a.ts", "src/decision/", true],
    [".github/workflows/ci.yml", ".github/**", true],
    ["src/core/ledger.ts", "src/core/ledger.ts", true],
    ["src/core/ledger.tsx", "src/core/ledger.ts", false],
    ["src/core/ledger.ts.bak", "src/core/ledger.ts", false],
    ["src/core/lock.ts", "src/core/*.ts", true],
    ["src/core/sub/lock.ts", "src/core/*.ts", false],
    ["src/core/a.ts", "src/core/?.ts", true],
    ["src/core/ab.ts", "src/core/?.ts", false],
    ["tests/x/enforcement/a.ts", "**/enforcement/*.ts", true],
    ["enforcement/a.ts", "**/enforcement/*.ts", true],
    ["package.json", "package.json", true],
    ["a.package.json", "package.json", false],
    ["src/core/ledgerXts", "src/core/ledger.ts", false],
    ["axb", "a.b", false],
    ["a.b", "a.b", true],
    ["a+b", "a+b", true],
    ["aab", "a+b", false],
    ["a|b", "a|b", true],
    ["a", "a|b", false],
    ["a$b", "a$b", true],
    ["ab", "a$b", false],
    ["a^b", "a^b", true],
    ["a/b", "a?b", false],
    ["a/b", "a/**/b", true],
    ["a/x/y/b", "a/**/b", true],
    ["a/xb", "a/**/b", false],
    ["a(b)", "a(b)", true],
    ["ab", "a(b)", false],
    ["a[b]", "a[b]", true],
    ["ab", "a[b]", false],
    ["a{b}", "a{b}", true],
    ["a\\b", "a\\b", true],
  ])("%s against %s is %s", (file, pattern, expected) => {
    expect(hits(file, pattern)).toBe(expected);
  });

  it("reports each file once, with the first pattern that matched, in input order", () => {
    expect(matchKernelPaths(["b/x.ts", "a/y.ts", "c.txt"], ["a/**", "b/**", "**"])).toEqual([
      { file: "b/x.ts", pattern: "b/**" },
      { file: "a/y.ts", pattern: "a/**" },
      { file: "c.txt", pattern: "**" },
    ]);
  });
});

describe("the default list", () => {
  it("equals the checked-in list when the file exists, and every exact src path in it exists", () => {
    if (existsSync(LIST_FILE)) expect(DEFAULT_KERNEL_PATHS).toEqual(parseList(readFileSync(LIST_FILE, "utf8")));
    for (const pattern of DEFAULT_KERNEL_PATHS.filter(
      (p) => p.startsWith("src/") && !/[*?]/.test(p) && !p.endsWith("/"),
    )) {
      expect(existsSync(join(ROOT, pattern)), pattern).toBe(true);
    }
  });

  it("keeps the ledger, the gates and the CI definitions on it", () => {
    const hit = (file: string): boolean => matchKernelPaths([file], DEFAULT_KERNEL_PATHS).length === 1;
    expect(hit("src/core/ledger.ts")).toBe(true);
    expect(hit("src/work/gates.ts")).toBe(true);
    expect(hit(".github/workflows/outer-suite.yml")).toBe(true);
    expect(hit("tests/enforcement/W-ci-advisory.test.ts")).toBe(true);
    expect(hit("README.md")).toBe(false);
  });
});

describe("scripts/kernel-paths.mjs CLI", () => {
  it("exports the sentence the workflow greps and the docs quote", () => {
    expect(KERNEL_NOTICE).toBe(NOTICE);
  });

  it("lists the files on kernel paths, names a renamed-away kernel file by its old name, and exits 0", () => {
    const { repo, base, head: tip } = renamedRepo();
    const list = join(makeTempDir("omf-kp-"), "list.txt");
    writeFileSync(list, "# test list\nsrc/decision/**\n.github/**\n");
    const out = report(["--repo", repo, "--base", base, "--head", tip, "--list", list]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("Files on kernel paths: 2 of 4 changed.");
    expect(out.stdout).toContain("- `src/decision/a.ts` (src/decision/**)");
    expect(out.stdout).toContain("- `.github/workflows/ci.yml` (.github/**)");
    expect(out.stdout).not.toContain("docs/x.md");
    expect(out.stdout).toContain(NOTICE);
  });

  it("says no kernel path was touched, without the owner sentence, and still exits 0", () => {
    const { repo, base, head: tip } = renamedRepo();
    const list = join(makeTempDir("omf-kp-"), "list.txt");
    writeFileSync(list, "schemas/**\n");
    const out = report(["--repo", repo, "--base", base, "--head", tip, "--list", list]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("No kernel path touched.");
    expect(out.stdout).not.toContain("kernel paths touched:");
  });

  it("uses the built-in list when the list file is absent and says so", () => {
    const { repo, base, head: tip } = renamedRepo();
    const out = report(["--repo", repo, "--base", base, "--head", tip, "--list", join(repo, "missing.txt")]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("built-in default");
    expect(out.stdout).toContain("`.github/workflows/ci.yml`");
  });

  it("exits 2 when git cannot diff the two shas, and when the list is unsafe", () => {
    const { repo, base, head: tip } = renamedRepo();
    const unknown = report(["--repo", repo, "--base", "1".repeat(40), "--head", tip]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("git diff failed");
    const list = join(makeTempDir("omf-kp-"), "list.txt");
    writeFileSync(list, "../outside/**\n");
    const unsafe = report(["--repo", repo, "--base", base, "--head", tip, "--list", list]);
    expect(unsafe.status).toBe(2);
    expect(unsafe.stderr).toContain("line 1");
  });

  it("reads the diff against the merge base: what the base branch gained meanwhile is not reported", () => {
    const repo = makeGitRepo();
    write(repo, "README.md", "# r\n");
    commitAll(repo, "root");
    const fork = head(repo);
    gitIn(repo, "checkout", "-q", "-b", "feature");
    write(repo, "docs/f.md", "# f\n");
    commitAll(repo, "feature");
    const feature = head(repo);
    gitIn(repo, "checkout", "-q", "main");
    write(repo, "src/decision/main-only.ts", "export const m = 1;\n");
    commitAll(repo, "main moves on");
    const main = head(repo);
    expect(gitIn(repo, "merge-base", main, feature).trim()).toBe(fork);
    const list = join(makeTempDir("omf-kp-"), "list.txt");
    writeFileSync(list, "src/decision/**\n");
    const out = report(["--repo", repo, "--base", main, "--head", feature, "--list", list]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("No kernel path touched.");
    expect(out.stdout).not.toContain("main-only");
  });

  it("names a file with a space, a backtick or non-ASCII letters in its name, escaped in the code span", () => {
    const repo = makeGitRepo();
    write(repo, "README.md", "# r\n");
    commitAll(repo, "root");
    const base = head(repo);
    write(repo, "src/decision/a b.ts", "x\n");
    write(repo, "src/decision/tick`name.ts", "x\n");
    write(repo, "src/decision/caf\u00e9.ts", "x\n");
    commitAll(repo, "odd names");
    const list = join(makeTempDir("omf-kp-"), "list.txt");
    writeFileSync(list, "src/decision/**\n");
    const out = report(["--repo", repo, "--base", base, "--head", head(repo), "--list", list]);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain("Files on kernel paths: 3 of 3 changed.");
    expect(out.stdout).toContain("- `src/decision/a b.ts` (src/decision/**)");
    expect(out.stdout).toContain("- `src/decision/tick'name.ts` (src/decision/**)");
    expect(out.stdout).toContain("- `src/decision/caf\u00e9.ts` (src/decision/**)");
    expect(out.stdout.split("\n").filter((line) => line.startsWith("- ")).length).toBe(3);
  });

  it("states which list it used and how many patterns it holds", () => {
    const { repo, base, head: tip } = renamedRepo();
    const list = join(makeTempDir("omf-kp-"), "list.txt");
    writeFileSync(list, "# c\nsrc/decision/**\n.github/**\n");
    const fromFile = report(["--repo", repo, "--base", base, "--head", tip, "--list", list]);
    expect(fromFile.stdout).toContain("List: docs/maintainers/kernel-paths.txt (2 patterns).");
    const fallback = report(["--repo", repo, "--base", base, "--head", tip, "--list", join(repo, "absent.txt")]);
    expect(fallback.stdout).toContain(
      `List: built-in default; docs/maintainers/kernel-paths.txt is absent (${DEFAULT_KERNEL_PATHS.length} patterns).`,
    );
  });

  it.each([
    ["no arguments", [], "--base must be a full 40-character"],
    ["a flag with no value", ["--base"], "usage: --repo"],
    [
      "an unknown flag",
      ["--bogus", "x"],
      'usage: --repo <dir> --base <sha> --head <sha> [--list <file>] (got "--bogus")',
    ],
    [
      "a base that is not a full sha",
      ["--base", "main", "--head", "0".repeat(40)],
      "--base must be a full 40-character",
    ],
    ["an abbreviated base", ["--base", "abcdef1", "--head", "0".repeat(40)], "--base must be a full 40-character"],
    ["an uppercase base", ["--base", "A".repeat(40), "--head", "0".repeat(40)], "--base must be a full 40-character"],
    [
      "a base one character too long",
      ["--base", "a".repeat(41), "--head", "0".repeat(40)],
      "--base must be a full 40-character",
    ],
    ["a head that is not a sha", ["--base", "0".repeat(40), "--head", "HEAD"], "--head must be a full 40-character"],
    ["a missing head", ["--base", "0".repeat(40)], "--head must be a full 40-character"],
  ])("exits 2 for %s and says why", (_name, args, message) => {
    const out = report(args as string[]);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain(message);
    expect(out.stdout).toBe("");
  });
});
