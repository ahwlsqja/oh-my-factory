import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type GitFixture, gitFixture } from "./git-fixture.js";
import { gitIn } from "./tmp.js";

export const BUGGY = "export const add = (a, b) => a - b;\n";
export const FIXED = "export const add = (a, b) => a + b;\n";

/** A node test file. `body` runs inside `test("add", ...)` with `assert` and `add` in scope. */
export const testFile = (body: string): string =>
  `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/calc.mjs";\ntest("add", () => {\n  ${body}\n});\n`;

/** The declared test command: node's own runner, which finds `tests/calc.test.mjs`. */
export const TEST_COMMAND: readonly string[] = [process.execPath, "--test"];

/** base: the bug. head: the fix plus a test that fails on the bug. One non-test path, one test path. */
export function calcFixture(body = "assert.equal(add(1, 2), 3);"): GitFixture {
  return gitFixture({ "src/calc.mjs": BUGGY }, { "src/calc.mjs": FIXED, "tests/calc.test.mjs": testFile(body) });
}

/** Everything git could have been made to change in the shared repository, as one comparable string. */
export function snapshot(fx: GitFixture): string {
  const sha256 = (path: string): string =>
    createHash("sha256")
      .update(readFileSync(join(fx.repo, path)))
      .digest("hex");
  return JSON.stringify({
    tree: gitIn(fx.repo, "rev-parse", "HEAD^{tree}"),
    refs: gitIn(fx.repo, "for-each-ref"),
    staged: gitIn(fx.repo, "ls-files", "--stage"),
    status: gitIn(fx.repo, "status", "--porcelain", "--ignored"),
    index: sha256(".git/index"),
    config: sha256(".git/config"),
  });
}
