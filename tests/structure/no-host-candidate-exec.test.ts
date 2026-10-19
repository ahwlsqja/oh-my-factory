import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

/**
 * The one named exception: the container work copy implements the work-copy ports and runs every command inside a
 * container through the ContainerRuntime port. M3c's fixture runner is a ScenarioRunner and needs no entry (cross-plan X-24).
 */
const ALLOWED_HOST_ADAPTERS: readonly string[] = ["container/work-copy.ts"];

/** A class, object or function that is a CommandTarget, WorkCopy or WorkCopyFactory. Interfaces that only `extend` one and method signatures ending in `;` are fine. */
const PORT = "CommandTarget|WorkCopyFactory|WorkCopy";
const IMPLEMENTS = new RegExp(
  [
    `\\bimplements\\s+[^{\\n]*\\b(?:${PORT})\\b`,
    `:\\s*(?:${PORT})\\s*=\\s*\\{`,
    `\\bsatisfies\\s+(?:${PORT})\\b`,
    `\\bas\\s+(?:${PORT})\\b`,
    // A function or arrow that declares one of them as its return type and has a body: the shape of tests/helpers/fixture-target.ts.
    `\\)\\s*:\\s*(?:Promise<\\s*)?(?:${PORT})\\s*>?\\s*(?:=>|\\{)`,
  ].join("|"),
);
/** A value import of the process runner, or any mention of node:child_process as a module. */
const SPAWNS =
  /^import\s+(?!type\b)[^;]*["']\.\.?\/(?:[^"']*\/)?adapters\/process-group\.js["']|["'](?:node:)?child_process["']/m;
/** Imports `process-group` from within the adapters directory or any other relative path. */
const SPAWNS_ANY =
  /^import\s+(?!type\b)[^;]*["']\.\.?\/(?:[^"']*\/)?process-group\.js["']|["'](?:node:)?child_process["']/m;

/** The only modules that may start a process (M3e-D7). Anything else that imports node:child_process or the process runner fails. */
const MAY_SPAWN: readonly string[] = [
  "adapters/process-group.ts",
  "adapters/measure-cmd.ts",
  "adapters/reconciler.ts",
  "container/docker-cli.ts",
  "core/actor.ts",
  "core/doctor.ts",
  "core/lock.ts",
  "core/paths.ts",
  "git/hardened.ts",
  "goal/git.ts",
  // Runs only OMF's own hash-verified fixtures, never repository code (`W-host-runner-fixture-only.test.ts`).
  "scenario/fixtures.ts",
  // Runs the seal author command, which is not candidate code; the author is a host stub and is reported as unmeasured.
  "seal/session.ts",
  // The synchronous twin of the Docker CLI adapter, for the doctor probe only; it spawns the `docker` program and nothing else.
  "container/docker-sync.ts",
  // Opens only the fixed platform browser launcher with one URL argument, never candidate code (ui-browser.test.ts).
  "cli/ui.ts",
];

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
    expect(IMPLEMENTS.test(" * implements this by spawning on the host.\n */\nexport interface CommandTarget {")).toBe(
      false,
    );
    expect(SPAWNS.test('import { runProcessGroup } from "../adapters/process-group.js";')).toBe(true);
    expect(SPAWNS.test('import { spawn } from "node:child_process";')).toBe(true);
    expect(IMPLEMENTS.test("export class Host implements WorkCopyFactory {")).toBe(true);
    // tests/helpers/fixture-target.ts, the shape of a host-side CommandTarget.
    expect(
      IMPLEMENTS.test(
        "export function fixtureTarget(cwd: string): CommandTarget {\n  return {\n    run: (argv, options) => runProcessGroup(argv, {}),\n  };\n}",
      ),
    ).toBe(true);
    expect(IMPLEMENTS.test("export const makeCopy = async (id: string): Promise<WorkCopy> => ({ id })")).toBe(true);
    expect(IMPLEMENTS.test("  create(spec: { quarantine: GitTarget; sha: string }): Promise<WorkCopy>;")).toBe(false);
    expect(SPAWNS_ANY.test('import { runProcessGroup } from "./process-group.js";')).toBe(true);
    expect(SPAWNS.test('import type { ProcessResult } from "../adapters/process-group.js";')).toBe(false);
  });

  it("no src/ module implements CommandTarget or WorkCopy, apart from the named adapter", () => {
    const offenders = sources().filter(
      ({ file, text }) => IMPLEMENTS.test(text) && !ALLOWED_HOST_ADAPTERS.includes(file),
    );
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("the named adapter exists, implements the ports and starts no process", () => {
    const adapter = sources().find(({ file }) => file === "container/work-copy.ts");
    expect(adapter).toBeDefined();
    expect(IMPLEMENTS.test(adapter?.text ?? "")).toBe(true);
    expect(SPAWNS_ANY.test(adapter?.text ?? "")).toBe(false);
  });

  it("the gate, audit and isolation modules start no process", () => {
    const offenders = sources().filter(
      ({ file, text }) => NO_SPAWN_DIRS.some((dir) => file.startsWith(`${dir}/`)) && SPAWNS.test(text),
    );
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("only the listed modules import node:child_process or the process runner", () => {
    const offenders = sources().filter(({ file, text }) => SPAWNS_ANY.test(text) && !MAY_SPAWN.includes(file));
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("the docker adapter starts only the docker program", () => {
    const text = readFileSync(join(SRC, "container/docker-cli.ts"), "utf8");
    const programs = [...text.matchAll(/\b(?:runProcessGroup|spawnSync)\(\s*(\[?\s*"[^"]*")/g)].map(
      (match) => match[1] ?? "",
    );
    expect(programs.length).toBeGreaterThan(0);
    expect(programs.filter((program) => !program.endsWith('"docker"'))).toEqual([]);
  });

  it("only the hardened runner starts git for container-written data", () => {
    const offenders = sources().filter(
      ({ file, text }) => file.startsWith("git/") && file !== "git/hardened.ts" && /node:child_process/.test(text),
    );
    expect(offenders.map((o) => o.file)).toEqual([]);
  });
});
