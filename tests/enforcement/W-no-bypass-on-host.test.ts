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
/** Claude's spellings: allowed in one place only, the argv of the implementer container. */
const CLAUDE_BYPASS = /dangerously-skip-permissions|bypassPermissions/;
/** Codex's spellings: there is no Codex implementer in this version, so they are allowed nowhere that ships. */
const CODEX_BYPASS = /dangerously-bypass-approvals-and-sandbox|--yolo\b|danger-full-access/;
const BYPASS = new RegExp(`${CLAUDE_BYPASS.source}|${CODEX_BYPASS.source}`);
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
const bypassFiles = (files: readonly Source[]): string[] =>
  files.filter((s) => CLAUDE_BYPASS.test(s.text)).map((s) => s.file);
const codexBypassFiles = (files: readonly Source[]): string[] =>
  files.filter((s) => CODEX_BYPASS.test(s.text)).map((s) => s.file);

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
    const codex: Source[] = [
      { file: "src/d.ts", text: 'const f = "--dangerously-bypass-approvals-and-sandbox";' },
      { file: "scripts/e.mjs", text: 'args.push("--yolo")' },
      { file: "harness/f.sh", text: "sandbox_mode = danger-full-access" },
      { file: "src/g.ts", text: "const yolos = 1; const clean = 2;" },
    ];
    expect(codexBypassFiles(codex)).toEqual(["src/d.ts", "scripts/e.mjs", "harness/f.sh"]);
    for (const spelling of ["--dangerously-bypass-approvals-and-sandbox", "--yolo", "danger-full-access"]) {
      expect(BYPASS.test(`codex exec ${spelling}`), spelling).toBe(true);
    }
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

  it("names no Codex permission-bypass spelling in any shipped file", () => {
    expect(codexBypassFiles(shipped())).toEqual([]);
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
