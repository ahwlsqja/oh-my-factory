import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/git/ops.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/git/ops.js")>()),
  revertPatch: vi.fn(async () => ""),
}));

import type { WorkCopyFactory } from "../../src/gate/ports.js";
import { proveTest } from "../../src/gate/prove-test.js";
import { TEST_COMMAND, calcFixture } from "../helpers/prove-fixture.js";

describe("proveTest with an empty revert patch", () => {
  it("is MISCONFIGURED / empty-revert-patch and makes no copy", async () => {
    const fx = calcFixture();
    let created = 0;
    const copies: WorkCopyFactory = {
      create: async () => {
        created += 1;
        throw new Error("no copy expected");
      },
    };
    const result = await proveTest({ quarantine: fx.quarantine, base: fx.base, head: fx.head, testCommand: TEST_COMMAND, explicitTestPaths: [], copies });
    expect(result).toEqual({ status: "MISCONFIGURED", reason: "empty-revert-patch", test_exit: null, non_test_paths: 1, test_paths: 1 });
    expect(created).toBe(0);
  });
});
