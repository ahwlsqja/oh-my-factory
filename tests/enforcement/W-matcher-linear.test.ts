import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_MATCH_INPUT, compilePattern, evaluateExpect, matchWhole } from "../../src/scenario/matcher.js";

// Spec §5.3 and M3-D5: a model writes the patterns, so a pattern must never be able to cost more than
// O(n * m) and the host must never hand one to its own regex engine. Both are proved here.
const SCENARIO_SOURCES = ["matcher.ts"] as const;

function program(pattern: string) {
  const compiled = compilePattern(pattern);
  if (!compiled.ok) throw new Error(`pattern did not compile: ${compiled.error}`);
  return compiled.program;
}

describe("W-matcher-linear", () => {
  it("refuses every construct that could backtrack, at compile time", () => {
    for (const pattern of ["^(a+)+$", "^(a|aa)+$", "^(?:a*)*$", "^a{1,99}$", "^(a)\\1$", "^(?=a)a$", "^a|b$"]) {
      expect(compilePattern(pattern), pattern).toEqual({ ok: false, error: "unsupported_construct" });
    }
    // The classic catastrophic input exists for a host engine and never reaches an evaluator here.
    const verdict = evaluateExpect(
      { exit_code: null, stdout_matches: { kind: "anchored", pattern: "^(a+)+$" }, json_path: null, note: "n" },
      { outcome: "exited", exit_code: 0, stdout: `${"a".repeat(40)}!` },
    );
    expect(verdict).toEqual({ pass: false, failed: ["stdout"] });
  });

  it("refuses an unanchored pattern, so a substring match cannot exist", () => {
    for (const pattern of ["abc", "^abc", "abc$", ".*abc.*"]) {
      expect(compilePattern(pattern), pattern).toEqual({ ok: false, error: "not_anchored" });
    }
  });

  it("finishes a pathological pattern on 100000 characters within the step bound", () => {
    const pattern = `^${"a*".repeat(9)}b$`;
    const compiled = program(pattern);
    const m = compiled.items.length;
    const n = 100_000;
    expect(n).toBeLessThan(MAX_MATCH_INPUT);
    for (const [input, matched] of [
      ["a".repeat(n), false],
      [`${"a".repeat(n)}b`, true],
    ] as const) {
      const started = performance.now();
      const result = matchWhole(compiled, input);
      const elapsed = performance.now() - started;
      expect(result.matched).toBe(matched);
      expect(result.steps).toBeLessThanOrEqual(2 * (input.length + 1) * (m + 1));
      expect(elapsed).toBeLessThan(1000);
    }
  });

  it("builds no host regular expression from scenario data", () => {
    for (const file of SCENARIO_SOURCES) {
      const source = readFileSync(fileURLToPath(new URL(`../../src/scenario/${file}`, import.meta.url)), "utf8");
      expect(source, file).not.toMatch(/RegExp/);
    }
  });
});
