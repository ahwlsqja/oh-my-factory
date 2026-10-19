import { describe, expect, it } from "vitest";
import { findTestWeakening } from "../../src/work/test-weakening.js";

/** A one-file unified diff with the given hunk body lines. */
function modify(path: string, body: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,5 +1,5 @@",
    ...body,
    "",
  ].join("\n");
}

describe("findTestWeakening", () => {
  it("finds nothing in an added test file", () => {
    const diff = [
      "diff --git a/tests/new.test.ts b/tests/new.test.ts",
      "new file mode 100644",
      "index 0000000..2222222",
      "--- /dev/null",
      "+++ b/tests/new.test.ts",
      "@@ -0,0 +1,3 @@",
      '+it("works", () => {',
      "+  expect(1).toBe(1);",
      "+});",
      "",
    ].join("\n");
    expect(findTestWeakening(diff, [])).toEqual([]);
  });

  it("finds nothing in a test edit that adds assertions", () => {
    const diff = modify("tests/a.test.ts", [
      " it('a', () => {",
      "-  expect(a).toBe(1);",
      "+  expect(a).toBe(2);",
      "+  expect(b).toBe(3);",
      " });",
    ]);
    expect(findTestWeakening(diff, [])).toEqual([]);
  });

  it("flags a deleted test file", () => {
    const diff = [
      "diff --git a/tests/old.test.ts b/tests/old.test.ts",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/tests/old.test.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-it('a', () => {});",
      "-",
      "",
    ].join("\n");
    expect(findTestWeakening(diff, [])).toEqual(["tests/old.test.ts"]);
  });

  it("flags removed assertion lines that are not replaced", () => {
    const diff = modify("tests/a.test.ts", [
      "-  expect(a).toBe(1);",
      "-  assert.equal(b, 2);",
      "+  expect(a).toBe(1);",
    ]);
    expect(findTestWeakening(diff, [])).toEqual(["tests/a.test.ts"]);
  });

  it("does not flag an assertion that was only rewritten", () => {
    const diff = modify("tests/a.test.ts", ["-  expect(a).toBe(1);", "+  expect(a).toEqual(1);"]);
    expect(findTestWeakening(diff, [])).toEqual([]);
  });

  it.each([
    "it.skip('a', () => {});",
    "describe.only('a', () => {});",
    "test.todo('a');",
    "xit('a', () => {});",
    "xdescribe('a', () => {});",
    "fit('a', () => {});",
    "@pytest.mark.skip",
    't.Skip("later")',
    "@Disabled",
  ])("flags an added marker: %s", (line) => {
    const diff = modify("tests/a.test.ts", [` ctx`, `+${line}`]);
    expect(findTestWeakening(diff, [])).toEqual(["tests/a.test.ts"]);
  });

  it("flags a lowered threshold in a test and in a coverage config", () => {
    expect(findTestWeakening(modify("tests/a.test.ts", ["-const minimum = 90;", "+const minimum = 50;"]), [])).toEqual([
      "tests/a.test.ts",
    ]);
    expect(findTestWeakening(modify("vitest.config.ts", ["-      lines: 90,", "+      lines: 80,"]), [])).toEqual([
      "vitest.config.ts",
    ]);
  });

  it("does not flag a raised threshold or a number change in source code", () => {
    expect(findTestWeakening(modify("vitest.config.ts", ["-      lines: 80,", "+      lines: 90,"]), [])).toEqual([]);
    expect(findTestWeakening(modify("src/a.ts", ["-const minimum = 90;", "+const minimum = 50;"]), [])).toEqual([]);
  });

  it("ignores assertion removal and markers outside test files", () => {
    expect(findTestWeakening(modify("src/a.ts", ["-  expect(a).toBe(1);", "+  it.skip('x');"]), [])).toEqual([]);
  });

  it("honours explicit test paths", () => {
    const diff = modify("e2e/flow.ts", ["-  expect(a).toBe(1);"]);
    expect(findTestWeakening(diff, [])).toEqual([]);
    expect(findTestWeakening(diff, ["e2e"])).toEqual(["e2e/flow.ts"]);
  });

  it("returns a sorted list over several files", () => {
    const diff = modify("tests/b.test.ts", ["-  expect(a).toBe(1);"]) + modify("tests/a.test.ts", ["+it.skip('a');"]);
    expect(findTestWeakening(diff, [])).toEqual(["tests/a.test.ts", "tests/b.test.ts"]);
  });

  it("returns null when a file section cannot be read", () => {
    expect(findTestWeakening("diff --git garbage\n@@ -1 +1 @@\n-expect(a)\n", [])).toBeNull();
  });

  it("returns an empty list for an empty diff", () => {
    expect(findTestWeakening("", [])).toEqual([]);
  });

  it("flags a removed threshold line and a deleted coverage config that held one", () => {
    expect(findTestWeakening(modify("vitest.config.ts", ["-      lines: 90,", " "]), [])).toEqual(["vitest.config.ts"]);
    const deleted = [
      "diff --git a/codecov.yml b/codecov.yml",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/codecov.yml",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
      "-coverage:",
      "-  target: 80",
      "-",
      "",
    ].join("\n");
    expect(findTestWeakening(deleted, [])).toEqual(["codecov.yml"]);
    expect(findTestWeakening(modify("vitest.config.ts", ["-      include: ['src'],", " "]), [])).toEqual([]);
  });

  it("reads C-quoted git paths with octal escapes", () => {
    const quoted = '"tests/\\355\\225\\234\\352\\270\\200.test.ts"';
    const modifyQuoted = [
      `diff --git "a/tests/\\355\\225\\234\\352\\270\\200.test.ts" "b/tests/\\355\\225\\234\\352\\270\\200.test.ts"`,
      "index 1111111..2222222 100644",
      '--- "a/tests/\\355\\225\\234\\352\\270\\200.test.ts"',
      '+++ "b/tests/\\355\\225\\234\\352\\270\\200.test.ts"',
      "@@ -1,3 +1,1 @@",
      "-  expect(a).toBe(1);",
      "-  expect(b).toBe(2);",
      " x",
      "",
    ].join("\n");
    expect(quoted).toContain("355");
    expect(findTestWeakening(modifyQuoted, [])).toEqual(["tests/한글.test.ts"]);
    const deleted = [
      'diff --git "a/tests/\\355\\225\\234\\352\\270\\200.test.ts" "b/tests/\\355\\225\\234\\352\\270\\200.test.ts"',
      "deleted file mode 100644",
      "index 1111111..0000000",
      "Binary files a/x and /dev/null differ",
      "",
    ].join("\n");
    expect(findTestWeakening(deleted, [])).toEqual(["tests/한글.test.ts"]);
  });

  it("decodes quote, backslash and tab escapes in quoted paths", () => {
    const diff = [
      'diff --git "a/tests/a\\tb\\"c.test.ts" "b/tests/a\\tb\\"c.test.ts"',
      "index 1111111..2222222 100644",
      '--- "a/tests/a\\tb\\"c.test.ts"',
      '+++ "b/tests/a\\tb\\"c.test.ts"',
      "@@ -1,1 +1,0 @@",
      "-  expect(a).toBe(1);",
      "",
    ].join("\n");
    expect(findTestWeakening(diff, [])).toEqual(['tests/a\tb"c.test.ts']);
  });
});
