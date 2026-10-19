#!/usr/bin/env node
// Reports which files of a pull request sit on kernel paths: the files that decide what the tool promises, so the owner
// reads their diff before merging and no agent merges them. Report only: it exits 0 whether or not a kernel path was
// touched, and 2 only when it cannot do its job (bad arguments, an unsafe list, git cannot diff the two commits).
// Dependency-free on purpose: the workflow runs the BASE commit's copy of this file without installing anything, so a pull
// request cannot rewrite the check that judges it.
//
// Usage: node scripts/kernel-paths.mjs --repo <dir> --base <40-hex sha> --head <40-hex sha> [--list <file>]
// The list is one repository-relative pattern per line (`#` comments and blank lines are ignored). Supported syntax:
// `*` (inside one path segment), `**` (across segments), `?`, a trailing `/` (everything below), and exact paths.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const KERNEL_NOTICE =
  "kernel paths touched: the owner merges this after reading the diff; agents do not merge it";

/** The owner's list (docs/maintainers/kernel-paths.txt), comments dropped, used while that file is absent from the base commit. A test pins it equal to the file when the file exists. */
export const DEFAULT_KERNEL_PATHS = [
  "src/core/**",
  "src/goal/**",
  "src/work/**",
  "src/scenario/**",
  "src/feedback/**",
  "src/decision/**",
  "src/cli/decide-sign.ts",
  "src/cli/confirm.ts",
  "src/ui/**",
  "src/cli/ui.ts",
  "tests/ui/**",
  "tests/cli/ui-*.test.ts",
  "tests/structure/no-host-candidate-exec.test.ts",
  "src/git/**",
  "src/adapters/**",
  "src/gate/**",
  "src/judge/**",
  "src/seal/**",
  "src/vault/**",
  "src/isolation/**",
  "src/audit/**",
  "src/container/**",
  "src/implementer/**",
  "harness/**",
  "fixtures/**",
  "schemas/**",
  "tests/enforcement/**",
  "tests/global-setup.ts",
  "tests/helpers/bin-shims/**",
  ".github/workflows/**",
  ".github/CODEOWNERS",
  "package.json",
  "package-lock.json",
  "vitest.config.*",
  "scripts/gated-docker.mjs",
  "docs/evidence/gated-runs.json",
  "docs/design/**",
  "docs/ko/design/**",
  "docs/maintainers/kernel-paths.txt",
  "tests/docs/kernel-paths.test.ts",
  "docs/maintainers/development-workflow.md",
  "AGENTS.md",
  "CLAUDE.md",
  "src/author/**",
  "outer/**",
  "docs/requirements.json",
  "scripts/conformance-matrix.mjs",
  "scripts/kernel-paths.mjs",
  "docs/maintainers/stage0.txt",
];

const FULL_SHA = /^[0-9a-f]{40}$/;
const LIST_PATH = "docs/maintainers/kernel-paths.txt";

/** Parses the list text. Throws on anything that could silently match nothing or match outside the repository. */
export function parseList(text) {
  const patterns = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const where = `kernel-paths: line ${index + 1}`;
    if (line.startsWith("/") || /^[A-Za-z]:/.test(line) || line.includes("\\") || line.split("/").includes("..")) {
      throw new Error(`${where} is not a repository-relative pattern: ${JSON.stringify(line)}`);
    }
    if (/[{}[\]()!]/.test(line)) {
      throw new Error(
        `${where} uses glob syntax this list does not support (only *, ** and ?): ${JSON.stringify(line)}`,
      );
    }
    patterns.push(line);
  }
  return patterns;
}

// `.` does not match a newline, and git names files byte-exact, so `**` is spelled [\s\S] to keep a newline in a name from
// escaping a directory pattern.
function toRegExp(pattern) {
  const glob = pattern.endsWith("/") ? `${pattern}**` : pattern;
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        source += "(?:[\\s\\S]*/)?";
        i += 2;
      } else {
        source += "[\\s\\S]*";
        i += 1;
      }
    } else if (ch === "*") {
      source += "[^/]*";
    } else if (ch === "?") {
      source += "[^/]";
    } else {
      source += ch.replace(/[.+^$|\\(){}[\]]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/** The files that match some pattern, each once with the first pattern that matched, in input order. */
export function matchKernelPaths(files, patterns) {
  const compiled = patterns.map((pattern) => ({ pattern, regex: toRegExp(pattern) }));
  const hits = [];
  for (const file of files) {
    const found = compiled.find((entry) => entry.regex.test(file));
    if (found) hits.push({ file, pattern: found.pattern });
  }
  return hits;
}

/**
 * Files changed between the merge base and the head. Renames are reported as a delete plus an add (--no-renames), so a
 * kernel file moved out of a kernel directory is still named by its old path.
 */
export function changedFiles(repo, base, head) {
  let out;
  try {
    out = execFileSync("git", ["-C", repo, "diff", "--name-only", "--no-renames", "-z", `${base}...${head}`, "--"], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const first = String(error.stderr ?? error.message).split("\n")[0];
    throw new Error(`kernel-paths: git diff failed: ${first}`);
  }
  return out.split("\0").filter((name) => name !== "");
}

/** A file name shown in a code span; names with a backtick or a control character are shown as JSON. */
function shown(name) {
  const odd = [...name].some((ch) => ch === "`" || ch.charCodeAt(0) < 32);
  return `\`${odd ? JSON.stringify(name).slice(1, -1).replaceAll("`", "'") : name}\``;
}

function renderReport({ files, hits, source, count }) {
  const lines = ["## Kernel paths", "", `List: ${source} (${count} patterns).`, ""];
  if (hits.length === 0) {
    lines.push("No kernel path touched.");
  } else {
    lines.push(`Files on kernel paths: ${hits.length} of ${files.length} changed.`, "");
    for (const hit of hits) lines.push(`- ${shown(hit.file)} (${hit.pattern})`);
    lines.push("", KERNEL_NOTICE);
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const opts = { repo: "." };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!["--repo", "--base", "--head", "--list"].includes(key) || value === undefined) {
      throw new Error(
        `kernel-paths: usage: --repo <dir> --base <sha> --head <sha> [--list <file>] (got ${JSON.stringify(key)})`,
      );
    }
    opts[key.slice(2)] = value;
  }
  for (const key of ["base", "head"]) {
    if (!FULL_SHA.test(opts[key] ?? ""))
      throw new Error(`kernel-paths: --${key} must be a full 40-character lowercase sha`);
  }
  return opts;
}

function main(argv) {
  try {
    const opts = parseArgs(argv);
    const fromFile = opts.list !== undefined && existsSync(opts.list);
    const patterns = fromFile ? parseList(readFileSync(opts.list, "utf8")) : DEFAULT_KERNEL_PATHS;
    const source = fromFile ? LIST_PATH : `built-in default; ${LIST_PATH} is absent`;
    const files = changedFiles(opts.repo, opts.base, opts.head);
    const hits = matchKernelPaths(files, patterns);
    process.stdout.write(renderReport({ files, hits, source, count: patterns.length }));
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
