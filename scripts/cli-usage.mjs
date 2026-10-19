#!/usr/bin/env node
// Generates and checks docs/cli-usage.md: the exact `--help` text of every leaf command of the built CLI, one block per
// command (spec §13). The file is generated so that a command can never be documented differently from what it prints.
//
//   npm run build && node scripts/cli-usage.mjs --write    rewrite the file
//   node scripts/cli-usage.mjs --check                     exit 1, naming each verb that drifted
//
// Options: --file <path> (default docs/cli-usage.md), --cli <path> (default dist/cli/main.js), both relative to the
// repository root. Exit codes: 0 ok, 1 the file and the CLI disagree, 2 the script could not run (usage, no build).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const USAGE_FILE = "docs/cli-usage.md";
export const EXIT = { ok: 0, drift: 1, usage: 2 };

const HEADER = [
  "# Command usage",
  "",
  "The exact `--help` text of every leaf command of the built `omf`, one block per command. This file is generated:",
  "run `npm run build && node scripts/cli-usage.mjs --write` after changing a command. `npm test` fails when this file",
  "and the CLI disagree, and names the command.",
  "",
].join("\n");

/** Names under commander's "Commands:" heading. Wrapped descriptions are indented further and never match. */
export function subcommands(help) {
  const lines = help.split("\n");
  const start = lines.indexOf("Commands:");
  if (start === -1) return [];
  const names = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") break;
    const match = /^ {2}([a-z][a-z-]*)(?: |$)/.exec(line);
    if (match?.[1] !== undefined && match[1] !== "help") names.push(match[1]);
  }
  return names;
}

/** Every leaf command as { path, help }, in the order the CLI lists them. `runHelp(prefix)` returns that command's help. */
export function discoverLeaves(runHelp, prefix = []) {
  const help = runHelp(prefix);
  const children = subcommands(help);
  if (children.length > 0) return children.flatMap((name) => discoverLeaves(runHelp, [...prefix, name]));
  if (prefix.length === 0) throw new Error("the root help lists no commands");
  return [{ path: prefix.join(" "), help }];
}

const trimmed = (help) => help.replace(/\n+$/, "");

export function renderUsage(blocks) {
  const parts = [HEADER];
  for (const { path, help } of blocks) {
    if (help.includes("```"))
      throw new Error(`omf ${path}: the help text holds a code fence, which the file cannot quote`);
    parts.push(`## omf ${path}\n\n\`\`\`text\n${trimmed(help)}\n\`\`\`\n`);
  }
  return parts.join("\n");
}

export function parseUsage(text) {
  const pattern = /^## omf (.+)\n\n```text\n([\s\S]*?)\n```$/gm;
  return [...text.matchAll(pattern)].map((match) => ({ path: match[1], help: match[2] }));
}

/** One line per problem, each naming the verb. Empty means the file is exactly what `--write` would produce. */
export function compareUsage(expected, text) {
  const actual = new Map(parseUsage(text).map((block) => [block.path, block.help]));
  const want = new Map(expected.map((block) => [block.path, trimmed(block.help)]));
  const problems = [];
  for (const [path, help] of want) {
    if (!actual.has(path)) problems.push(`omf ${path}: no block in ${USAGE_FILE}`);
    else if (actual.get(path) !== help) problems.push(`omf ${path}: the block differs from --help`);
  }
  for (const path of actual.keys()) {
    if (!want.has(path)) problems.push(`omf ${path}: block for a command that no longer exists`);
  }
  if (problems.length === 0 && text !== renderUsage(expected)) {
    problems.push(`${USAGE_FILE}: text outside the blocks was edited`);
  }
  return problems;
}

/** The environment of a help run: no inherited location or credential, a throwaway HOME, no colour, no terminal width. */
export function cleanEnv(home, base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const drop =
      key.startsWith("GIT_") ||
      key.startsWith("XDG_") ||
      key.startsWith("OMF_") ||
      key.startsWith("ANTHROPIC_") ||
      key.startsWith("OPENAI_") ||
      key.endsWith("_API_KEY") ||
      ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "COLUMNS", "FORCE_COLOR"].includes(key);
    if (!drop) env[key] = value;
  }
  return { ...env, HOME: home, NO_COLOR: "1" };
}

export function builtHelpRunner(cli, home, cwd) {
  return (prefix) => {
    const run = spawnSync(process.execPath, [cli, ...prefix, "--help"], { cwd, env: cleanEnv(home), encoding: "utf8" });
    if (run.status !== 0) throw new Error(`omf ${prefix.join(" ")} --help exited ${run.status}: ${run.stderr}`.trim());
    return run.stdout;
  };
}

export function parseArgs(argv) {
  let mode = null;
  let file = USAGE_FILE;
  let cli = "dist/cli/main.js";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--write" || arg === "--check") {
      const next = arg.slice(2);
      if (mode !== null && mode !== next) return { error: "give --write or --check, not both" };
      mode = next;
    } else if (arg === "--file" || arg === "--cli") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return { error: `${arg} needs a path` };
      i += 1;
      if (arg === "--file") file = value;
      else cli = value;
    } else {
      return { error: `unknown argument ${arg}` };
    }
  }
  if (mode === null) return { error: "give --write or --check" };
  return { mode, file, cli };
}

export function main(argv, io = { log: console.log, error: console.error }) {
  const args = parseArgs(argv);
  if ("error" in args) {
    io.error(`${args.error}\nusage: node scripts/cli-usage.mjs --write | --check [--file <path>] [--cli <path>]`);
    return EXIT.usage;
  }
  const file = resolve(ROOT, args.file);
  const scratch = mkdtempSync(join(tmpdir(), "omf-usage-"));
  try {
    let blocks;
    try {
      blocks = discoverLeaves(builtHelpRunner(resolve(ROOT, args.cli), scratch, scratch));
    } catch (err) {
      io.error(`${err instanceof Error ? err.message : String(err)}\nbuild first: npm run build`);
      return EXIT.usage;
    }
    if (args.mode === "write") {
      writeFileSync(file, renderUsage(blocks));
      io.log(`wrote ${args.file}: ${blocks.length} commands`);
      return EXIT.ok;
    }
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      io.error(`${args.file} is missing; run: node scripts/cli-usage.mjs --write`);
      return EXIT.drift;
    }
    const problems = compareUsage(blocks, text);
    for (const problem of problems) io.error(problem);
    if (problems.length > 0) io.error("regenerate it with: npm run build && node scripts/cli-usage.mjs --write");
    else io.log(`${args.file} matches the built CLI (${blocks.length} commands)`);
    return problems.length === 0 ? EXIT.ok : EXIT.drift;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
