import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The seam test appends the author measurement itself, so it may show the line's logic but must never be read as sealing
// evidence: it names itself a seam, the conformance matrix cannot count it, and it cannot assert merge_recommended (owner
// decision O-1: the noise check is never evaluated, so a success is capped at human_needed).

const ROOT = new URL("../../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, ROOT), "utf8");
const SEAM = "tests/acceptance/seam.test.ts";
const SIBLING = "tests/enforcement/W-no-merge-recommended-in-m3f.test.ts";

/**
 * Splits TypeScript source into its live code (comments blanked, string contents kept) and its line comments that start in
 * column 0. Block comments, trailing comments and text inside strings therefore never satisfy a check meant for live code.
 */
function scan(text: string): { code: string; headers: string[] } {
  let code = "";
  const headers: string[] = [];
  let i = 0;
  let lineStart = true;
  while (i < text.length) {
    const ch = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      if (lineStart) headers.push(text.slice(i, stop));
      i = stop;
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      code += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
      code += text.slice(i, j + 1);
      i = j + 1;
      lineStart = false;
      continue;
    } else {
      code += ch;
    }
    if (ch === "\n") lineStart = true;
    else if (ch !== " " && ch !== "\t") lineStart = false;
    if (ch === "/" && (next === "/" || next === "*")) lineStart = false;
    i += ch === "/" && (next === "/" || next === "*") ? 0 : 1;
  }
  return { code, headers };
}

const liveSeam = (text: string): boolean => {
  const { code, headers } = scan(text);
  return headers.some((line) => /^\/\/ SEAM test/.test(line)) && /^describe\("seam:/m.test(code);
};
const ceiling = (text: string): { human: boolean; denies: boolean; positive: boolean } => {
  const { code } = scan(text);
  const lines = code.split("\n").filter((line) => line.includes("merge_recommended"));
  return {
    human: /^\s*expect\([^;]*\)\.toBe\("human_needed"\)/m.test(code),
    denies: /^\s*expect\([^;]*\)\.not\.toBe\("merge_recommended"\)/m.test(code),
    positive: lines.some((line) => /expect\(/.test(line) && !line.includes(".not.")),
  };
};

describe("W-skeleton-seam", () => {
  const seam = read(SEAM);

  it("names itself a seam in its header and in its test title, in live code and not in a comment or a string", () => {
    expect(liveSeam(seam)).toBe(true);
    expect(liveSeam('/*\n// SEAM test\n*/\ndescribe("seam: x", () => {});')).toBe(false);
    expect(liveSeam('// SEAM test\n/* describe("seam: x") */')).toBe(false);
    expect(liveSeam("// SEAM test\nconst t = '\\ndescribe(\"seam:';")).toBe(false);
    expect(liveSeam('import x from "y"; // SEAM test\ndescribe("seam: x", () => {});')).toBe(false);
    expect(liveSeam('// SEAM test\ndescribe("seam: x", () => {});')).toBe(true);
  });

  it("is mapped to no requirement and carries no covers marker", () => {
    expect(seam).not.toMatch(/covers:/);
    const doc = JSON.parse(read("docs/requirements.json")) as { requirements: { tests?: { path: string }[] }[] };
    const mapped = doc.requirements.flatMap((entry) => entry.tests ?? []).map((test) => test.path);
    expect(mapped).not.toContain(SEAM);
  });

  it("holds the O-1 ceiling: it asserts human_needed and mentions merge_recommended only to deny it", () => {
    expect(ceiling(seam)).toEqual({ human: true, denies: true, positive: false });
    // Positive controls: a ceiling that lives only in a comment, or a positive assertion, does not count.
    expect(ceiling('// expect(x).toBe("human_needed")\n// expect(x).not.toBe("merge_recommended")')).toEqual({
      human: false,
      denies: false,
      positive: false,
    });
    expect(ceiling('expect(x).toBe("merge_recommended"); // .not.')).toMatchObject({ denies: false, positive: true });
    expect(ceiling('expect(x).toBe("human_needed");\nexpect(y).not.toBe("merge_recommended");')).toMatchObject({
      human: true,
      denies: true,
    });
    // The sibling that pins the same ceiling for the real stations still runs the line and still asserts it.
    const sibling = scan(read(SIBLING)).code;
    expect(sibling).toMatch(/await runSeamLine\(/);
    expect(sibling).toMatch(/expect\([^;]*recommendation\)\.toBe\("human_needed"\)/);
  });
});
