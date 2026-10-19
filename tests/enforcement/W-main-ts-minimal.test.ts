// covers: S5.0.verbs-thin-adapters
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The read-only `omf ui` work edits src/cli/main.ts in parallel. The W verbs therefore sit behind one registration
// function in their own files, and main.ts holds exactly one import and one call (M3h-D18).
const read = (path: string): string => readFileSync(new URL(`../../src/cli/${path}`, import.meta.url), "utf8");

const W_MODULE =
  /(?:\bfrom\s*["'`]|\bimport\s*\(\s*["'`]|^\s*import\s+["'`])\.\/(?:seal|run|report|w-assembly)(?:\.js)?["'`]/m;
const W_COMMAND = /\.(?:command|addCommand)\s*\(\s*(?:new\s+Command\s*\(\s*)?["'`](?:seal|run|report)(?:["'`\s[<])/;
/** What main.ts must not do: import a W module in any quote style, with or without .js, or register a W verb in any form. */
const violations = (source: string): string[] => [
  ...(W_MODULE.test(source) ? ["imports a W module"] : []),
  ...(W_COMMAND.test(source) ? ["registers a W verb"] : []),
];

describe("src/cli/main.ts stays minimal", () => {
  it("imports and calls registerWCommands once", () => {
    const main = read("main.ts");
    expect(main).toContain('import { registerWCommands } from "./w-commands.js";');
    expect(main.match(/registerWCommands\(program\);/g)).toHaveLength(1);
  });

  it("names none of the W verbs and does not import their modules", () => {
    expect(violations(read("main.ts"))).toEqual([]);
  });

  it("the check sees every way to import a W module or register a W verb (positive controls)", () => {
    const planted = [
      'import { x } from "./seal.js";',
      "import { x } from './seal.js';",
      'import { x } from "./seal";',
      "import { x } from `./run.js`;",
      'import "./report.js";',
      "const m = await import('./w-assembly.js');",
      'program.command("seal");',
      "program.command(`seal`);",
      'program.command("report [id]");',
      "program.command('run <work_id>');",
      'program.addCommand(new Command("run"));',
      'program\n  .command("report")',
    ];
    for (const line of planted) expect(violations(line), line).not.toEqual([]);
    const fine = [
      'import { registerWCommands } from "./w-commands.js";',
      'import { registerUiCommand } from "./ui.js";',
      'program.command("rework");',
      'program.command("ui");',
      'program.command("goal").description("run goals");',
    ];
    for (const line of fine) expect(violations(line), line).toEqual([]);
  });

  it("registers the verbs in w-commands.ts, each in its own file", () => {
    expect(read("w-commands.ts")).toContain("registerSealCommand(program);");
    expect(read("seal.ts")).toMatch(/\.command\("seal"\)/);
  });
});
