import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The deviations file is the record of where M3c's contract differs from the spec's examples or leaves a seam
// for M3b2. It must stay complete and honest: every entry present, every file it names real.
const ROOT = new URL("../../", import.meta.url);
const text = (): string => readFileSync(new URL("docs/m3c-spec-deviations.md", ROOT), "utf8");
const ids = Array.from({ length: 11 }, (_, i) => `V${i + 1}`);

describe("M3c spec deviations", () => {
  it.each(ids)("records deviation %s", (id) => {
    expect(text()).toMatch(new RegExp(`^\\| ${id} \\|`, "m"));
  });

  it("names only repository paths that exist", () => {
    const named = [...text().matchAll(/`((?:src|tests|schemas|fixtures|docs)\/[A-Za-z0-9_./-]+)`/g)].map((m) => m[1] ?? "");
    expect(named.length).toBeGreaterThan(8);
    expect(named.filter((path) => !existsSync(new URL(path, ROOT)))).toEqual([]);
  });

  it("holds no full canary literal", () => {
    expect(text()).not.toMatch(/omf-canary-[0-9a-f]{32}/);
  });
});
