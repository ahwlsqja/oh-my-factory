import { describe, expect, it } from "vitest";
import {
  MAX_MATCH_INPUT,
  type PatternError,
  type PatternProgram,
  compileJsonPath,
  compilePattern,
  evaluateExpect,
  evaluateJsonPath,
  matchWhole,
} from "../../src/scenario/matcher.js";
import {
  CANARY_PATTERN,
  CANARY_SEARCH,
  EXPOSURE_LIMIT,
  type Expect,
  SCENARIO_ID_PATTERN,
  SCENARIO_REF_PATTERN,
  type StepObservation,
  isCanaryKind,
  scenarioRef,
} from "../../src/scenario/types.js";
import { sha256Hex } from "../../src/core/canonical-json.js";

function program(pattern: string): PatternProgram {
  const compiled = compilePattern(pattern);
  if (!compiled.ok) throw new Error(`pattern did not compile: ${compiled.error}`);
  return compiled.program;
}

const matches = (pattern: string, input: string): boolean => matchWhole(program(pattern), input).matched;

describe("scenario types", () => {
  it("keeps the identifiers opaque and the handle derived", () => {
    const id = `s-${"a".repeat(32)}`;
    expect(SCENARIO_ID_PATTERN.test(id)).toBe(true);
    expect(SCENARIO_ID_PATTERN.test(`s-${"A".repeat(32)}`)).toBe(false);
    expect(scenarioRef(id)).toBe(sha256Hex(id).slice(0, 16));
    expect(SCENARIO_REF_PATTERN.test(scenarioRef(id))).toBe(true);
    expect(scenarioRef(id)).not.toBe(scenarioRef(`s-${"b".repeat(32)}`));
  });

  it("finds a canary inside text but anchors the stored form", () => {
    const canary = `omf-canary-${"a".repeat(32)}`;
    expect(CANARY_PATTERN.test(canary)).toBe(true);
    expect(CANARY_PATTERN.test(`x ${canary}`)).toBe(false);
    expect(CANARY_SEARCH.test(`prefix ${canary} suffix`)).toBe(true);
    expect(CANARY_SEARCH.test("omf-canary-short")).toBe(false);
  });

  it("names the exposure limit and the canary kind", () => {
    expect(EXPOSURE_LIMIT).toBe(20);
    expect(isCanaryKind({ kind: "contradiction_canary" })).toBe(true);
    expect(isCanaryKind({ kind: "behavior" })).toBe(false);
  });
});

describe("compilePattern", () => {
  it("accepts the whole grammar", () => {
    for (const pattern of [
      "^$",
      "^abc$",
      "^a.c$",
      "^\\d+$",
      "^[a-c]+x?$",
      "^[^0-9]*$",
      "^a\\.b$",
      "^a\\$$",
      "^[\\d_-]+$",
      "^\\D\\W\\S$",
    ]) {
      expect(compilePattern(pattern).ok, pattern).toBe(true);
    }
  });

  it("refuses everything outside it, with the matching code", () => {
    const refusals: [string, PatternError][] = [
      ["", "not_anchored"],
      ["abc$", "not_anchored"],
      ["^abc", "not_anchored"],
      ["^a\\$", "not_anchored"],
      ["^(a+)+$", "unsupported_construct"],
      ["^a|b$", "unsupported_construct"],
      ["^a{2}$", "unsupported_construct"],
      ["^a$b$", "unsupported_construct"],
      ["^a^b$", "unsupported_construct"],
      ["^*a$", "unsupported_construct"],
      ["^a**$", "unsupported_construct"],
      ["^a+?$", "unsupported_construct"],
      ["^\\1$", "bad_escape"],
      ["^\\b$", "bad_escape"],
      ["^a\\", "bad_escape"],
      ["^[abc$", "bad_class"],
      ["^[z-a]$", "bad_class"],
      ["^[]$", "empty_class"],
      ["^[^]$", "empty_class"],
      [`^${"a".repeat(600)}$`, "too_long"],
    ];
    for (const [pattern, error] of refusals) {
      expect(compilePattern(pattern), pattern).toEqual({ ok: false, error });
    }
  });
});

describe("matchWhole", () => {
  it("matches the whole input only", () => {
    expect(matches("^abc$", "abc")).toBe(true);
    expect(matches("^abc$", "abcd")).toBe(false);
    expect(matches("^abc$", "xabc")).toBe(false);
    expect(matches("^$", "")).toBe(true);
    expect(matches("^$", "a")).toBe(false);
  });

  it("applies each quantifier", () => {
    expect(matches("^a?b*$", "")).toBe(true);
    expect(matches("^a?b*$", "abb")).toBe(true);
    expect(matches("^a?b*$", "ba")).toBe(false);
    expect(matches("^a+$", "a")).toBe(true);
    expect(matches("^a+$", "")).toBe(false);
  });

  it("treats . as any code point except a newline, and a negated class as anything not listed", () => {
    expect(matches("^a.c$", "abc")).toBe(true);
    expect(matches("^a.c$", "a\u{1F600}c")).toBe(true);
    expect(matches("^a.c$", "a\nc")).toBe(false);
    expect(matches("^[^a]$", "\n")).toBe(true);
    expect(matches("^[^a]$", "a")).toBe(false);
  });

  it("knows the escapes and the ranges", () => {
    expect(matches("^\\d+$", "123")).toBe(true);
    expect(matches("^\\d+$", "12a")).toBe(false);
    expect(matches("^\\w+\\s\\S$", "ab c")).toBe(true);
    expect(matches("^[a-c0-9_-]+$", "a-9_c")).toBe(true);
    expect(matches("^[a-c]+$", "abd")).toBe(false);
    expect(matches("^a\\.b$", "a.b")).toBe(true);
    expect(matches("^a\\.b$", "axb")).toBe(false);
  });

  it("stays within the step bound and never matches input above the cap", () => {
    const small = matchWhole(program("^a*a*b$"), "aaaa");
    expect(small.steps).toBeLessThanOrEqual(2 * (4 + 1) * (3 + 1));
    expect(matchWhole(program("^a*$"), "a".repeat(MAX_MATCH_INPUT + 1))).toEqual({ matched: false, steps: 0 });
  });
});

describe("json_path", () => {
  it("compiles the small subset and refuses the rest", () => {
    expect(compileJsonPath("$.a[0].b_1")).toEqual({ ok: true, segments: ["a", 0, "b_1"] });
    expect(compileJsonPath("$")).toEqual({ ok: true, segments: [] });
    expect(compileJsonPath(`$${".a".repeat(16)}`).ok).toBe(true);
    for (const path of [
      "a",
      "$.",
      "$.1a",
      "$[ ]",
      "$[-1]",
      "$[01]",
      "$['a']",
      "$..a",
      "$.a b",
      `$${".a".repeat(17)}`,
    ]) {
      expect(compileJsonPath(path).ok, path).toBe(false);
    }
  });

  it("evaluates keys and indexes on own properties only", () => {
    const doc = { a: { b: [1, "x", null] }, c: false };
    expect(evaluateJsonPath(doc, ["a", "b", 1])).toEqual({ found: true, value: "x" });
    expect(evaluateJsonPath(doc, ["a", "b", 2])).toEqual({ found: true, value: null });
    expect(evaluateJsonPath(doc, ["c"])).toEqual({ found: true, value: false });
    expect(evaluateJsonPath(doc, [])).toEqual({ found: true, value: doc });
    expect(evaluateJsonPath(doc, ["a", "b", 3])).toEqual({ found: false });
    expect(evaluateJsonPath(doc, ["a", 0])).toEqual({ found: false });
    expect(evaluateJsonPath(doc, ["a", "b", "length"])).toEqual({ found: false });
    expect(evaluateJsonPath(doc, ["toString"])).toEqual({ found: false });
    expect(evaluateJsonPath(null, ["a"])).toEqual({ found: false });
  });
});

const only = (over: Partial<Expect>): Expect => ({
  exit_code: null,
  stdout_matches: null,
  json_path: null,
  note: "n",
  ...over,
});
const exited = (stdout: string, exit_code = 0): StepObservation => ({ outcome: "exited", exit_code, stdout });

describe("evaluateExpect", () => {
  it("fails every expectation when the process did not exit by itself", () => {
    const observations: StepObservation[] = [
      { outcome: "signaled", signal: "SIGKILL" },
      { outcome: "timeout" },
      { outcome: "output_limit" },
      { outcome: "error" },
      { outcome: "refused", code: "candidate_needs_container" },
    ];
    for (const observation of observations) {
      for (const expectation of [only({ exit_code: 0 }), only({ stdout_matches: { kind: "exact", text: "" } })]) {
        expect(evaluateExpect(expectation, observation)).toEqual({ pass: false, failed: ["not_exited"] });
      }
    }
  });

  it("compares the exit code", () => {
    expect(evaluateExpect(only({ exit_code: 3 }), exited("", 3))).toEqual({ pass: true });
    expect(evaluateExpect(only({ exit_code: 3 }), exited("", 0))).toEqual({ pass: false, failed: ["exit_code"] });
  });

  it("takes an exact match as the whole stdout, newline included, with no trimming", () => {
    const exact = (text: string): Expect => only({ stdout_matches: { kind: "exact", text } });
    expect(evaluateExpect(exact("hi\n"), exited("hi\n"))).toEqual({ pass: true });
    expect(evaluateExpect(exact("hi\n"), exited("hi"))).toEqual({ pass: false, failed: ["stdout"] });
    expect(evaluateExpect(exact("hi"), exited("hi\n"))).toEqual({ pass: false, failed: ["stdout"] });
    expect(evaluateExpect(exact(""), exited(""))).toEqual({ pass: true });
  });

  it("matches an anchored pattern with the linear matcher and fails one that does not compile", () => {
    const anchored = (pattern: string): Expect => only({ stdout_matches: { kind: "anchored", pattern } });
    expect(evaluateExpect(anchored("^\\d+\n$"), exited("42\n"))).toEqual({ pass: true });
    expect(evaluateExpect(anchored("^\\d+$"), exited("42\n"))).toEqual({ pass: false, failed: ["stdout"] });
    expect(evaluateExpect(anchored("^(a+)+$"), exited("aaa"))).toEqual({ pass: false, failed: ["stdout"] });
  });

  it("fails stdout above the cap even when the exact text equals it", () => {
    const big = "a".repeat(MAX_MATCH_INPUT + 1);
    expect(evaluateExpect(only({ stdout_matches: { kind: "exact", text: big } }), exited(big))).toEqual({
      pass: false,
      failed: ["stdout"],
    });
  });

  it("checks json_path entries by strict equality", () => {
    const stdout = JSON.stringify({ a: { b: [1, "x"] }, ok: true });
    const paths = (json_path: Expect["json_path"]): Expect => only({ json_path });
    expect(evaluateExpect(paths({ "$.a.b[0]": 1, "$.a.b[1]": "x", "$.ok": true }), exited(stdout))).toEqual({
      pass: true,
    });
    expect(evaluateExpect(paths({ "$.a.b[0]": "1" }), exited(stdout))).toEqual({ pass: false, failed: ["json_path"] });
    expect(evaluateExpect(paths({ "$.missing": 1 }), exited(stdout))).toEqual({ pass: false, failed: ["json_path"] });
    expect(evaluateExpect(paths({ "$..a": 1 }), exited(stdout))).toEqual({ pass: false, failed: ["json_path"] });
    expect(evaluateExpect(paths({ "$.ok": true }), exited("not json"))).toEqual({
      pass: false,
      failed: ["json_parse"],
    });
  });

  it("lists every failed part, and an empty expectation passes here (intake and lint refuse it, the null probes catch it)", () => {
    const both = only({ exit_code: 1, stdout_matches: { kind: "exact", text: "x" } });
    expect(evaluateExpect(both, exited("y", 0))).toEqual({ pass: false, failed: ["exit_code", "stdout"] });
    expect(evaluateExpect(only({}), exited("anything"))).toEqual({ pass: true });
  });
});
