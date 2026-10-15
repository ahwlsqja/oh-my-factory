import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url);
const PAGE = "docs/isolation-and-gates.md";

/**
 * The files the claim rule covers: the doctor and isolation page and the strings the CLI and doctor print. The design
 * spec (docs/design/) and the READMEs are not covered; they describe the design, not what a run measured.
 */
const CLAIM_FILES = [PAGE, "src/core/doctor.ts", "src/cli/main.ts"] as const;

/** A line that says a level was measured (`measured: L2`) or that something is sealed must say "not enforced" on the same line. */
const CLAIM = /measured:\s*"?L[123]\b|\bsealed\b/i;
const QUALIFIER = /not enforced/i;
const unqualifiedClaims = (text: string): string[] => text.split("\n").filter((line) => CLAIM.test(line) && !QUALIFIER.test(line));

const read = (path: string): string => readFileSync(new URL(path, ROOT), "utf8");

describe("M3e claim rule", () => {
  it("flags a claim without the qualifier and accepts one with it", () => {
    expect(unqualifiedClaims("isolation measured: L2")).toHaveLength(1);
    expect(unqualifiedClaims('{ measured: "L3" }')).toHaveLength(1);
    expect(unqualifiedClaims("the scenarios are sealed")).toHaveLength(1);
    expect(unqualifiedClaims("measured: L2 is not enforced until M3f")).toEqual([]);
    expect(unqualifiedClaims('measured: "unmeasured"')).toEqual([]);
    expect(unqualifiedClaims("no sealing guarantee, and nothing unsealed")).toEqual([]);
  });

  it.each(CLAIM_FILES)("%s makes no unqualified measured or sealed claim", (file) => {
    expect(unqualifiedClaims(read(file))).toEqual([]);
  });

  it("leaves the design spec out of scope", () => {
    expect(CLAIM_FILES.some((file) => file.startsWith("docs/design/"))).toBe(false);
  });
});

describe("docs/isolation-and-gates.md", () => {
  const ROWS = Array.from({ length: 14 }, (_, i) => `R${i + 1}`);

  it.each(ROWS)("records the re-check %s with a result", (id) => {
    expect(read(PAGE)).toMatch(new RegExp(`^\\| ${id} \\| .+ \\| .+ \\| (confirmed|deviation: .+) \\|$`, "m"));
  });

  it("names only repository paths that exist", () => {
    const named = [...read(PAGE).matchAll(/`((?:src|tests|schemas|docs)\/[A-Za-z0-9_./-]+)`/g)].map((m) => m[1] ?? "");
    expect(named.length).toBeGreaterThan(8);
    expect(named.filter((path) => !existsSync(new URL(path, ROOT)))).toEqual([]);
  });
});
