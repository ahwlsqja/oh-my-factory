import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildClaudeArgs } from "../../src/adapters/reconciler.js";
import { CONFIG_DEFAULTS } from "../../src/core/config.js";
import { BYPASS_FLAGS, claudeArgv, claudeSettings } from "../../src/implementer/claude-argv.js";

// A permission-bypass flag is safe only inside the measured container (spec §7). It is named in one file, handed to one
// module, and that module only reaches `ContainerRuntime.exec`. Nothing OMF ships can put it on a host process.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
/** Everything that ships or runs on the host: source, scripts, the harness image and the schemas. */
const SHIPPED = ["src", "scripts", "harness", "schemas"];
const BYPASS = /dangerously-skip-permissions|bypassPermissions/;
const ARGV_FILE = "src/implementer/claude-argv.ts";
const SESSION_FILE = "src/implementer/claude-session.ts";
/** A value import of the process runner or any mention of node:child_process; a type-only import of `ProcessResult` is fine. */
const SPAWNS = /^import\s+(?!type\b)[^;]*["'][^"']*process-group\.js["']|["'](?:node:)?child_process["']/m;

interface Source {
  file: string;
  text: string;
}

function filesUnder(root: string): Source[] {
  const dir = join(ROOT, root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((name) => name.split("\\").join("/"))
    .filter((name) => statSync(join(dir, name)).isFile())
    .map((name) => ({ file: `${root}/${name}`, text: readFileSync(join(dir, name), "utf8") }));
}

const shipped = (): Source[] => SHIPPED.flatMap(filesUnder);
const bypassFiles = (files: readonly Source[]): string[] => files.filter((s) => BYPASS.test(s.text)).map((s) => s.file);

const IMPORTS_ARGV = /(?:\bfrom|\bimport)\s*\(?\s*["'][^"']*claude-argv\.js["']/;
const importersOfArgv = (files: readonly Source[]): string[] =>
  files.filter((s) => s.file.startsWith("src/") && IMPORTS_ARGV.test(s.text)).map((s) => s.file);

describe("W-no-bypass-on-host", () => {
  it("the detectors catch a violation (positive control)", () => {
    const planted: Source[] = [
      { file: "src/a.ts", text: 'const f = "--dangerously-skip-permissions";' },
      { file: "scripts/b.mjs", text: "mode: 'bypassPermissions'" },
      { file: "src/c.ts", text: "const clean = 1;" },
    ];
    expect(bypassFiles(planted)).toEqual(["src/a.ts", "scripts/b.mjs"]);
    expect(
      importersOfArgv([
        { file: "src/x.ts", text: 'import { claudeArgv } from "./claude-argv.js";' },
        { file: "src/y.ts", text: 'export { claudeSettings } from "../implementer/claude-argv.js";' },
        { file: "src/z.ts", text: 'const m = await import("./claude-argv.js");' },
        { file: "tests/t.ts", text: 'import "./claude-argv.js";' },
        { file: "src/w.ts", text: 'import { other } from "./claude-session.js";' },
      ]),
    ).toEqual(["src/x.ts", "src/y.ts", "src/z.ts"]);
    expect(SPAWNS.test('import { spawn } from "node:child_process";')).toBe(true);
    expect(SPAWNS.test('import { runProcessGroup } from "../adapters/process-group.js";')).toBe(true);
    expect(SPAWNS.test('import type { ProcessResult } from "../adapters/process-group.js";')).toBe(false);
  });

  it("names a bypass flag in exactly one shipped file", () => {
    expect(bypassFiles(shipped())).toEqual([ARGV_FILE]);
    expect(BYPASS_FLAGS).toEqual(["--dangerously-skip-permissions"]);
  });

  it("imports that file from the Claude session only", () => {
    expect(importersOfArgv(shipped())).toEqual([SESSION_FILE]);
  });

  it("starts no process from the implementer modules: the only execution path is ContainerRuntime.exec", () => {
    const modules = filesUnder("src/implementer");
    expect(modules.length).toBeGreaterThan(0);
    expect(modules.filter((s) => SPAWNS.test(s.text)).map((s) => s.file)).toEqual([]);
    for (const file of [SESSION_FILE, "src/implementer/stub-session.ts"]) {
      const text = modules.find((s) => s.file === file)?.text ?? "";
      expect(text, file).toMatch(/\bruntime\.exec\(/);
    }
  });

  it("the argv of the host's own Claude client carries no bypass flag, and the container argv does", () => {
    const host = buildClaudeArgs({ ...CONFIG_DEFAULTS.reconciler, kind: "claude", model: "m1", max_budget_usd: 1 });
    expect(host.join(" ")).not.toMatch(BYPASS);
    expect(claudeArgv({ model: null, maxBudgetUsd: null })).toEqual(expect.arrayContaining([...BYPASS_FLAGS]));
    expect(claudeArgv({ model: null, maxBudgetUsd: null })).not.toContain("--bare");
  });

  it("the generated settings never select a permission mode", () => {
    expect(claudeSettings({ denyEditGlobs: ["tests/**"] })).not.toMatch(BYPASS);
  });
});
