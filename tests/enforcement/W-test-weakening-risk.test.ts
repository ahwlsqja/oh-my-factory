import { describe, expect, it } from "vitest";
import { classifyLiteralPaths } from "../../src/work/risk.js";

// Owner decision on #65: a test change is not high risk by itself. The deterministic test-weakening check decides, and when it
// cannot run (no diff text) a test change stays high.
const base = { watchedGlobs: [], extraGlobs: [] };

describe("W-test-weakening-risk", () => {
  it("a test path the check did not flag is normal", () => {
    expect(classifyLiteralPaths({ ...base, paths: ["tests/new.test.ts"], weakeningPaths: [] }).class).toBe("normal");
  });

  it("a flagged test path is high by the rule test-weakening", () => {
    expect(classifyLiteralPaths({ ...base, paths: ["tests/a.test.ts"], weakeningPaths: ["tests/a.test.ts"] })).toEqual({
      class: "high",
      rules: ["test-weakening"],
      paths: ["tests/a.test.ts"],
    });
  });

  it.each([undefined, null])("a missing check (%s) keeps a test path high by the rule test", (weakeningPaths) => {
    expect(classifyLiteralPaths({ ...base, paths: ["tests/a.test.ts"], weakeningPaths })).toEqual({
      class: "high",
      rules: ["test"],
      paths: ["tests/a.test.ts"],
    });
  });
});
