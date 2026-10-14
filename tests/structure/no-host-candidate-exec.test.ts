import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

/** Kept for a future named exception; M3c's fixture runner is a ScenarioRunner and needs no entry (cross-plan X-24). */
const ALLOWED_HOST_ADAPTERS: readonly string[] = [];

/** A class or object that is a CommandTarget or WorkCopy. Interfaces that only `extend` one are fine. */
const IMPLEMENTS = /\bimplements\s+[^{\n]*\b(CommandTarget|WorkCopy)\b|:\s*(CommandTarget|WorkCopy)\s*=\s*\{|\bsatisfies\s+(CommandTarget|WorkCopy)\b|\bas\s+(CommandTarget|WorkCopy)\b/;
/** A value import of the process runner, or any import of node:child_process. */
const SPAWNS = /^import\s+(?!type\b)[^;]*["']\.\.?\/(?:[^"']*\/)?adapters\/process-group\.js["']|["']node:child_process["']/m;

const NO_SPAWN_DIRS = ["gate", "audit", "isolation"];

function sources(): Array<{ file: string; text: string }> {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => name.split("\\").join("/"))
    .map((name) => ({ file: name, text: readFileSync(join(SRC, name), "utf8") }));
}

describe("no module under src/ runs candidate code on the host (M3e-D7)", () => {
  it("the patterns catch a violation (positive control)", () => {
    expect(IMPLEMENTS.test("export class HostTarget implements CommandTarget {")).toBe(true);
    expect(IMPLEMENTS.test("const t: CommandTarget = { run: async () => x };")).toBe(true);
    expect(IMPLEMENTS.test("export class C implements Other, WorkCopy {")).toBe(true);
    expect(IMPLEMENTS.test("export interface WorkCopy extends CommandTarget {")).toBe(false);
    expect(IMPLEMENTS.test(" * implements this by spawning on the host.\n */\nexport interface CommandTarget {")).toBe(false);
    expect(SPAWNS.test('import { runProcessGroup } from "../adapters/process-group.js";')).toBe(true);
    expect(SPAWNS.test('import { spawn } from "node:child_process";')).toBe(true);
    expect(SPAWNS.test('import type { ProcessResult } from "../adapters/process-group.js";')).toBe(false);
  });

  it("no src/ module implements CommandTarget or WorkCopy, apart from the named adapter", () => {
    const offenders = sources().filter(({ file, text }) => IMPLEMENTS.test(text) && !ALLOWED_HOST_ADAPTERS.includes(file));
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("the gate, audit and isolation modules start no process", () => {
    const offenders = sources().filter(({ file, text }) => NO_SPAWN_DIRS.some((dir) => file.startsWith(`${dir}/`)) && SPAWNS.test(text));
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("only the hardened runner starts git for container-written data", () => {
    const offenders = sources().filter(({ file, text }) => file.startsWith("git/") && file !== "git/hardened.ts" && /node:child_process/.test(text));
    expect(offenders.map((o) => o.file)).toEqual([]);
  });
});
