import { describe, expect, it } from "vitest";
import { validate, validateDef } from "../../src/core/schema.js";
import { findForbiddenKey } from "../../src/work/work-item.js";

const candidate = {
  title: "Cache the search index",
  problem: "Search rebuilds its index on every request.",
  proposed_outcome: "Search keeps a warm index between requests.",
  affected_users_systems: "Anyone who searches.",
  constraints: "",
  open_questions: ["Which cache does the team already run?"],
  rationale: "Rebuilding is the slow part.",
  affected_paths: ["src/search", ".github/workflows/ci.yml", "docs/"],
};

const isValid = (patch: object): boolean =>
  validateDef("reconcile-output.schema.json", "candidate", { ...candidate, ...patch }).ok;

describe("reconcile-output envelope", () => {
  const envelope = (candidates: unknown[]): boolean => validate("reconcile-output.schema.json", { candidates }).ok;

  it("accepts zero to five candidates", () => {
    expect(envelope([])).toBe(true);
    expect(envelope([candidate, candidate, candidate, candidate, candidate])).toBe(true);
  });

  it("rejects six candidates, a missing list, an extra key and a non-object item", () => {
    expect(envelope(Array.from({ length: 6 }, () => candidate))).toBe(false);
    expect(validate("reconcile-output.schema.json", {}).ok).toBe(false);
    expect(validate("reconcile-output.schema.json", { candidates: [], note: "hi" }).ok).toBe(false);
    expect(envelope(["not an object"])).toBe(false);
  });
});

describe("reconcile-output candidate", () => {
  it("accepts a well-formed candidate, including an empty constraint and no paths", () => {
    expect(validateDef("reconcile-output.schema.json", "candidate", candidate)).toEqual({ ok: true });
    expect(isValid({ affected_paths: [], open_questions: [] })).toBe(true);
  });

  it.each(["threshold", "value", "query", "metric", "target"])("rejects an unknown field %s", (key) => {
    expect(isValid({ [key]: 1 })).toBe(false);
  });

  it("rejects a missing field and out-of-range lengths", () => {
    const { rationale: _rationale, ...missing } = candidate;
    expect(validateDef("reconcile-output.schema.json", "candidate", missing).ok).toBe(false);
    expect(isValid({ title: "" })).toBe(false);
    expect(isValid({ title: "x".repeat(121) })).toBe(false);
    expect(isValid({ title: "two\nlines" })).toBe(false);
    expect(isValid({ problem: "" })).toBe(false);
    expect(isValid({ problem: "x".repeat(2001) })).toBe(false);
    expect(isValid({ open_questions: Array.from({ length: 11 }, () => "why?") })).toBe(false);
    expect(isValid({ open_questions: ["two\nlines"] })).toBe(false);
    expect(isValid({ affected_paths: Array.from({ length: 21 }, (_, i) => `src/a${i}`) })).toBe(false);
  });

  it.each([
    "../secrets",
    "src/../../etc/passwd",
    "./src",
    ".",
    "/etc/passwd",
    "src/*.ts",
    "src/{a,b}",
    "src/a?.ts",
    "src/[ab].ts",
    "docs/My File.md",
    "src\\win",
    "src//double",
  ])("rejects the path %j", (path) => {
    expect(isValid({ affected_paths: [path] })).toBe(false);
  });

  it.each(["src", "src/", "src/search/index.ts", ".github/workflows/ci.yml", "packages/@scope/pkg", "a.b/c+d_e-f"])(
    "accepts the path %j",
    (path) => {
      expect(isValid({ affected_paths: [path] })).toBe(true);
    },
  );

  it("is a schema error to ask for a definition that does not exist", () => {
    expect(() => validateDef("reconcile-output.schema.json", "nope", {})).toThrow(/no definition nope/);
  });
});

describe("the forbidden-key scan on a model response", () => {
  it("finds a forbidden key on any candidate, however deep", () => {
    expect(findForbiddenKey({ candidates: [candidate, { ...candidate, extra: { Threshold: 1 } }] })).toBe(
      "candidates[1].extra.Threshold",
    );
    expect(findForbiddenKey({ candidates: [candidate] })).toBeNull();
  });
});
