import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The seam test appends the author measurement itself, so it may show the line's logic but must never be read as sealing
// evidence: it names itself a seam, the conformance matrix cannot count it, and it cannot assert merge_recommended (owner
// decision O-1: the noise check is never evaluated, so a success is capped at human_needed).

const ROOT = new URL("../../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, ROOT), "utf8");
const SEAM = "tests/acceptance/seam.test.ts";

describe("W-skeleton-seam", () => {
  const seam = read(SEAM);

  it("names itself a seam in its header and in its test title", () => {
    expect(seam).toMatch(/^\/\/ SEAM test/m);
    expect(seam).toMatch(/describe\("seam:/);
  });

  it("is mapped to no requirement and carries no covers marker", () => {
    expect(seam).not.toMatch(/covers:/);
    const doc = JSON.parse(read("docs/requirements.json")) as { requirements: { tests?: { path: string }[] }[] };
    const mapped = doc.requirements.flatMap((entry) => entry.tests ?? []).map((test) => test.path);
    expect(mapped).not.toContain(SEAM);
  });

  it("holds the O-1 ceiling: it asserts human_needed and mentions merge_recommended only to deny it", () => {
    expect(seam).toContain('toBe("human_needed")');
    const mentions = seam.split("\n").filter((text) => text.includes("expect(") && text.includes("merge_recommended"));
    expect(mentions.length).toBeGreaterThan(0);
    expect(mentions.every((text) => text.includes(".not."))).toBe(true);
    expect(existsSync(new URL("tests/enforcement/W-no-merge-recommended-in-m3f.test.ts", ROOT))).toBe(true);
  });
});
