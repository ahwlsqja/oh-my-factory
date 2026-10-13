import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The addendum is the record of what M2b decided where the spec was silent. It must stay complete (every
// decision and owner question present) and honest (every file it names exists).
const ROOT = new URL("../../", import.meta.url);
const ADDENDUM = new URL("docs/design/2026-10-12-omf-m2b-addendum.md", ROOT);
const text = (): string => readFileSync(ADDENDUM, "utf8");

const decisions = Array.from({ length: 30 }, (_, i) => `D${i + 1}`);
const questions = Array.from({ length: 9 }, (_, i) => `O${i + 1}`);

describe("M2b design addendum", () => {
  it.each(decisions)("records decision %s", (id) => {
    expect(text()).toMatch(new RegExp(`^\\| ${id} \\|`, "m"));
  });

  it.each(questions)("lists owner question %s", (id) => {
    expect(text()).toMatch(new RegExp(`^- \\*\\*${id}\\*\\* `, "m"));
  });

  it("names only repository paths that exist", () => {
    const named = [...text().matchAll(/`((?:src|tests|schemas|examples|scripts)\/[A-Za-z0-9_./-]+)`/g)].map((m) => m[1] ?? "");
    expect(named.length).toBeGreaterThan(10);
    expect(named.filter((path) => !existsSync(new URL(path, ROOT)))).toEqual([]);
  });
});
