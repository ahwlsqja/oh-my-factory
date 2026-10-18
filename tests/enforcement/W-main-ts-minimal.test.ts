// covers: S5.0.verbs-thin-adapters
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The read-only `omf ui` work edits src/cli/main.ts in parallel. The W verbs therefore sit behind one registration
// function in their own files, and main.ts holds exactly one import and one call (M3h-D18).
const read = (path: string): string => readFileSync(new URL(`../../src/cli/${path}`, import.meta.url), "utf8");

describe("src/cli/main.ts stays minimal", () => {
  it("imports and calls registerWCommands once", () => {
    const main = read("main.ts");
    expect(main).toContain('import { registerWCommands } from "./w-commands.js";');
    expect(main.match(/registerWCommands\(program\);/g)).toHaveLength(1);
  });

  it("names none of the W verbs and does not import their modules", () => {
    const main = read("main.ts");
    for (const verb of ["seal", "run", "report"]) {
      expect(main).not.toMatch(new RegExp(`\\.command\\(\\s*["']${verb}["']`));
    }
    for (const module of ["./seal.js", "./run.js", "./report.js", "./w-assembly.js"]) {
      expect(main).not.toContain(`"${module}"`);
    }
  });

  it("registers the verbs in w-commands.ts, each in its own file", () => {
    expect(read("w-commands.ts")).toContain("registerSealCommand(program);");
    expect(read("seal.ts")).toMatch(/\.command\("seal"\)/);
  });
});
