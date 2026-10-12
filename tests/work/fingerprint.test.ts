import { describe, expect, it } from "vitest";
import { fingerprintOf, normalizePath, normalizeTitle, workIdOf } from "../../src/work/fingerprint.js";

const base = { title: "Cache the search index", affected_paths: ["src/search", "src/cache/index.ts"] };

describe("normalizeTitle", () => {
  it("folds case, punctuation, width and whitespace", () => {
    expect(normalizeTitle("  Cache   the SEARCH-index!! ")).toBe("cache the search index");
    expect(normalizeTitle("Ｃａｃｈｅ the index")).toBe("cache the index");
    expect(normalizeTitle("Cache\tthe\nindex")).toBe("cache the index");
  });
});

describe("normalizePath", () => {
  it("drops ./ prefixes, doubled and trailing slashes, and converts backslashes", () => {
    expect(normalizePath("./src/search/")).toBe("src/search");
    expect(normalizePath("src//search")).toBe("src/search");
    expect(normalizePath("src/./search")).toBe("src/search");
    expect(normalizePath("src\\search")).toBe("src/search");
    expect(normalizePath("src/search")).toBe("src/search");
  });
});

describe("fingerprintOf", () => {
  it("is stable across path order, duplicates, ./ prefixes and trailing slashes", () => {
    const same = fingerprintOf("g-a", {
      title: base.title,
      affected_paths: ["./src/cache/index.ts", "src/search/", "src/search"],
    });
    expect(same).toBe(fingerprintOf("g-a", base));
  });

  it("is stable across title case, punctuation and whitespace", () => {
    expect(fingerprintOf("g-a", { ...base, title: "  cache THE search-index. " })).toBe(fingerprintOf("g-a", base));
  });

  it("differs for another goal, another path set or other title words", () => {
    const fingerprint = fingerprintOf("g-a", base);
    expect(fingerprintOf("g-b", base)).not.toBe(fingerprint);
    expect(fingerprintOf("g-a", { ...base, affected_paths: ["src/search"] })).not.toBe(fingerprint);
    expect(fingerprintOf("g-a", { ...base, title: "Cache the search results" })).not.toBe(fingerprint);
  });

  it("ignores every field except goal, title and paths", () => {
    const wide = { ...base, problem: "one wording", rationale: "because", constraints: "none" };
    const reworded = { ...base, problem: "another wording", rationale: "because of something else", constraints: "x" };
    expect(fingerprintOf("g-a", wide)).toBe(fingerprintOf("g-a", reworded));
  });

  it("is 64 lowercase hex digits", () => {
    expect(fingerprintOf("g-a", base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("workIdOf", () => {
  it("is w- plus the first 12 hex digits of the fingerprint", () => {
    const fingerprint = fingerprintOf("g-a", base);
    expect(workIdOf(fingerprint)).toBe(`w-${fingerprint.slice(0, 12)}`);
    expect(workIdOf(fingerprint)).toMatch(/^w-[0-9a-f]{12}$/);
  });

  it("refuses something that is not a fingerprint", () => {
    expect(() => workIdOf("abc")).toThrow(/64 lowercase hex/);
    expect(() => workIdOf("A".repeat(64))).toThrow(/64 lowercase hex/);
  });
});
