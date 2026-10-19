import { describe, expect, it } from "vitest";
import { classifyLiteralPaths, classifyRisk } from "../../src/work/risk.js";

// A test change is not high risk by itself. The deterministic test-weakening check decides, and when it
// cannot run (no diff text) a test change stays high.
const base = { watchedGlobs: [], extraGlobs: [] };

describe("W-test-weakening-risk", () => {
  it("a declared test path is normal at dispatch: there is no diff to weaken yet", () => {
    expect(classifyRisk({ ...base, declaredPaths: ["tests/new.test.ts"], tracked: [] }).class).toBe("normal");
  });

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

  it.each([undefined, null])(
    "a configured test path outside the default globs stays high by the rule test when the check is missing (%s)",
    (weakeningPaths) => {
      expect(
        classifyLiteralPaths({ ...base, paths: ["e2e/flow.ts"], weakeningPaths, explicitTestPaths: ["e2e"] }),
      ).toEqual({ class: "high", rules: ["test"], paths: ["e2e/flow.ts"] });
    },
  );

  it("a path outside the test globs and the configured test paths stays normal", () => {
    expect(
      classifyLiteralPaths({ ...base, paths: ["lib/flow.ts"], weakeningPaths: null, explicitTestPaths: ["e2e"] }).class,
    ).toBe("normal");
  });
});
