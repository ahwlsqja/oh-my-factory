import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { omf } from "../helpers/cli.js";
import { makeTempDir } from "../helpers/tmp.js";

// Spec §13 asks for a CLI usage drift test: every command the built CLI registers must be documented.
// The command list comes from the CLI's own --help, so a new command cannot be added without a README row.
const ROOT = new URL("../../", import.meta.url);
const readRepoFile = (path: string): string => readFileSync(new URL(path, ROOT), "utf8");

/** Names under commander's "Commands:" heading. Wrapped descriptions are indented further and never match. */
function subcommands(help: string): string[] {
  const lines = help.split("\n");
  const start = lines.indexOf("Commands:");
  if (start === -1) return [];
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") break;
    const match = /^ {2}([a-z][a-z-]*)(?: |$)/.exec(line);
    if (match?.[1] !== undefined && match[1] !== "help") names.push(match[1]);
  }
  return names;
}

/** Every leaf command as a path such as "goal tick". A command with no "Commands:" section is a leaf. */
function commandPaths(prefix: string[], cwd: string, home: string): string[] {
  const help = omf([...prefix, "--help"], cwd, home);
  expect(help.code, help.stderr).toBe(0);
  const children = subcommands(help.stdout);
  if (children.length === 0) return [prefix.join(" ")];
  return children.flatMap((name) => commandPaths([...prefix, name], cwd, home));
}

describe("documentation drift", () => {
  let paths: string[] = [];

  beforeAll(() => {
    paths = commandPaths([], makeTempDir(), makeTempDir("omf-home-"));
  }, 60_000);

  it("finds the commands the goal loop added", () => {
    for (const path of [
      "decide resolve", "decide defer",
      "goal tick", "goal status", "goal resume", "goal cancel",
      "work list", "work show", "work approve", "veto",
      "budget show", "budget declare", "budget raise",
      "decide add", "decide lint", "decide show",
    ]) {
      expect(paths).toContain(path);
    }
  });

  it.each(["README.md", "README.ko.md"])("%s has a table row for every command", (file) => {
    const rows = readRepoFile(file).split("\n").filter((line) => line.startsWith("| `omf "));
    const documented = (path: string): boolean => {
      const prefix = `| \`omf ${path}`;
      return rows.some((row) => row.startsWith(prefix) && /^[ `]/.test(row.slice(prefix.length)));
    };
    expect(paths.filter((path) => !documented(path))).toEqual([]);
  });

  it("goal tick --help works on the built CLI", () => {
    const out = omf(["goal", "tick", "--help"], makeTempDir(), makeTempDir("omf-home-"));
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("--runner");
    expect(out.stdout).toContain("--json");
  });

  it("budget raise documents both forms, in --help and in both READMEs", () => {
    const out = omf(["budget", "raise", "--help"], makeTempDir(), makeTempDir("omf-home-"));
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("--rounds");
    expect(out.stdout).toContain("--usd");
    for (const file of ["README.md", "README.ko.md"]) {
      expect(readRepoFile(file), file).toContain("omf budget raise <work_id> --rounds <n>");
    }
  });

  it("both READMEs point at the example and the addendum, and the English one at the smoke script", () => {
    for (const file of ["README.md", "README.ko.md"]) {
      const text = readRepoFile(file);
      expect(text, file).toContain("examples/hello-goal");
      expect(text, file).toContain("docs/design/2026-10-12-omf-m2b-addendum.md");
    }
    expect(readRepoFile("README.md")).toContain("scripts/smoke-reconciler.sh");
  });

  it("the enforcement README names every enforcement test file", () => {
    const readme = readRepoFile("tests/enforcement/README.md");
    const files = readdirSync(new URL("tests/enforcement/", ROOT)).filter((name) => name.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(5);
    expect(files.filter((name) => !readme.includes(name))).toEqual([]);
  });
});
