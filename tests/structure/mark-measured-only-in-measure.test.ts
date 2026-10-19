import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A handle is "measured" only because createMeasured judged its container. `markMeasured` is the one function that says so,
// so no module of src/ other than measure.ts may import, re-export or call it.
const SRC = fileURLToPath(new URL("../../src", import.meta.url));
const ALLOWED = new Set(["container/measure.ts", "container/measured-handles.ts"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("markMeasured", () => {
  const files = sourceFiles(SRC).map((path) => relative(SRC, path));

  it("finds the source tree", () => {
    expect(files).toContain("container/measure.ts");
    expect(files).toContain("container/measured-handles.ts");
  });

  it("is named by no file under src/ other than measure.ts and measured-handles.ts", () => {
    const naming = files.filter((file) => /\bmarkMeasured\b/.test(readFileSync(join(SRC, file), "utf8")));
    expect(naming.filter((file) => !ALLOWED.has(file))).toEqual([]);
    expect(naming).toContain("container/measure.ts");
  });
});
