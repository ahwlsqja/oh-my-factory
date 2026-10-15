import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkCopy, WorkCopyFactory } from "../../src/gate/ports.js";
import { type ProveTestInput, proveTest } from "../../src/gate/prove-test.js";
import type { GitTarget } from "../../src/git/hardened.js";
import { fixtureTarget } from "../helpers/fixture-target.js";
import { type GitFixture, gitFixture } from "../helpers/git-fixture.js";
import { realTempDir } from "../helpers/ops-fixture.js";
import { TEST_COMMAND, calcFixture, snapshot } from "../helpers/prove-fixture.js";
import { TempWorkCopyFactory } from "../helpers/temp-work-copy.js";

/** Delegates every method to `copy`; `over` replaces some. A spread would lose the class methods. */
function delegate(copy: WorkCopy, over: Partial<WorkCopy> = {}): WorkCopy {
  return {
    id: copy.id,
    run: (argv, options) => copy.run(argv, options),
    isClean: () => copy.isClean(),
    applyPatch: (patch, options) => copy.applyPatch(patch, options),
    dispose: () => copy.dispose(),
    abortSync: () => copy.abortSync(),
    ...over,
  };
}

/** Counts creations and disposals, can reshape the n-th copy, and can fail the n-th creation. */
class Recording implements WorkCopyFactory {
  created = 0;
  disposed = 0;
  constructor(
    private readonly inner: WorkCopyFactory,
    private readonly shape: (index: number) => Partial<WorkCopy> = () => ({}),
    private readonly failAt: number | null = null,
  ) {}

  async create(spec: { quarantine: GitTarget; sha: string }): Promise<WorkCopy> {
    const index = this.created;
    if (this.failAt === index) throw new Error("boom");
    this.created += 1;
    const copy = await this.inner.create(spec);
    return delegate(copy, {
      dispose: async () => {
        this.disposed += 1;
        await copy.dispose();
      },
      ...this.shape(index),
    });
  }
}

function setup(fx: GitFixture = calcFixture(), shape?: (index: number) => Partial<WorkCopy>, failAt: number | null = null) {
  const parent = realTempDir("omf-prove-");
  const inner = new TempWorkCopyFactory({ parent, exec: (root) => fixtureTarget(root) });
  const copies = new Recording(inner, shape, failAt);
  const input: ProveTestInput = {
    quarantine: fx.quarantine,
    base: fx.base,
    head: fx.head,
    testCommand: TEST_COMMAND,
    explicitTestPaths: [],
    copies,
    timeoutMs: 60_000,
  };
  return { fx, parent, copies, input };
}

describe("proveTest verdicts", () => {
  it("PROVEN: the fix reverted makes the test fail, in two separate copies, and the shared repository is untouched", async () => {
    const { fx, parent, copies, input } = setup();
    const before = snapshot(fx);
    const result = await proveTest(input);
    expect(result).toEqual({ status: "PROVEN", reason: null, test_exit: 1, non_test_paths: 1, test_paths: 1 });
    expect(copies.created).toBe(2);
    expect(copies.disposed).toBe(2);
    expect(readdirSync(parent)).toEqual([]);
    expect(snapshot(fx)).toBe(before);
  });

  it("FAILED: a test that passes without the fix", async () => {
    const { input } = setup(calcFixture("assert.equal(1, 1); void add;"));
    expect(await proveTest(input)).toEqual({ status: "FAILED", reason: "test-passed-without-fix", test_exit: 0, non_test_paths: 1, test_paths: 1 });
  });

  it("a build artifact written by the baseline cannot mask the revert, because the revert runs in a fresh copy", async () => {
    // The command trusts a `.cache` file: with a shared copy the baseline would write it and the reverted run would
    // pass on it (a false test-passed-without-fix). In a fresh copy the real test runs and fails.
    const script = [
      "const fs=require('node:fs'),cp=require('node:child_process');",
      "if(fs.existsSync('.cache'))process.exit(0);",
      "const r=cp.spawnSync(process.execPath,['--test'],{stdio:'ignore'});",
      "if(r.status===0)fs.writeFileSync('.cache','pass');",
      "process.exit(r.status===null?2:r.status);",
    ].join("");
    const { input, copies } = setup();
    const result = await proveTest({ ...input, testCommand: [process.execPath, "-e", script] });
    expect(result).toEqual({ status: "PROVEN", reason: null, test_exit: 1, non_test_paths: 1, test_paths: 1 });
    expect(copies.created).toBe(2);
  });

  it("counts only: no path appears in the result", async () => {
    const { input } = setup();
    const text = JSON.stringify(await proveTest(input));
    expect(text).not.toContain("calc");
    expect(text).not.toContain("/");
  });

  it("a path listed in explicitTestPaths is a test path", async () => {
    const files = { "src/calc.mjs": "export const add = (a, b) => a + b;\n", "e2e/flow.mjs": "export {};\n" };
    const fx = gitFixture({ "src/calc.mjs": "export const add = (a, b) => a - b;\n" }, files);
    const plain = await proveTest(setup(fx).input);
    expect(plain).toMatchObject({ non_test_paths: 2, test_paths: 0 });
    const listed = await proveTest({ ...setup(fx).input, explicitTestPaths: ["e2e"] });
    expect(listed).toMatchObject({ non_test_paths: 1, test_paths: 1 });
  });
});

describe("proveTest MISCONFIGURED reasons", () => {
  it("invalid-base-ref: an absent sha and a ref name are refused before any copy is made", async () => {
    for (const base of ["0".repeat(40), "main"]) {
      const { input, copies } = setup();
      expect(await proveTest({ ...input, base })).toEqual({ status: "MISCONFIGURED", reason: "invalid-base-ref", test_exit: null, non_test_paths: 0, test_paths: 0 });
      expect(copies.created).toBe(0);
    }
  });

  it("base-not-ancestor: base and head swapped", async () => {
    const { fx, input, copies } = setup();
    expect(await proveTest({ ...input, base: fx.head, head: fx.base })).toMatchObject({ status: "MISCONFIGURED", reason: "base-not-ancestor" });
    expect(copies.created).toBe(0);
  });

  it("no-non-test-change: a change that only touches tests", async () => {
    const fx = gitFixture({ "tests/a.test.mjs": "// 1\n" }, { "tests/a.test.mjs": "// 2\n" });
    const { input, copies } = setup(fx);
    expect(await proveTest(input)).toEqual({ status: "MISCONFIGURED", reason: "no-non-test-change", test_exit: null, non_test_paths: 0, test_paths: 1 });
    expect(copies.created).toBe(0);
  });

  it("working-tree-not-clean: the baseline copy and the reverted copy are each checked", async () => {
    const first = setup(undefined, (index) => (index === 0 ? { isClean: async () => false } : {}));
    expect(await proveTest(first.input)).toMatchObject({ status: "MISCONFIGURED", reason: "working-tree-not-clean" });
    expect(first.copies.created).toBe(1);
    expect(first.copies.disposed).toBe(1);
    const second = setup(undefined, (index) => (index === 1 ? { isClean: async () => false } : {}));
    expect(await proveTest(second.input)).toMatchObject({ status: "MISCONFIGURED", reason: "working-tree-not-clean" });
    expect(second.copies.created).toBe(2);
    expect(second.copies.disposed).toBe(2);
  });

  it("baseline-test-failed: the declared command fails on the head itself", async () => {
    const { input, copies } = setup();
    const result = await proveTest({ ...input, testCommand: [process.execPath, "-e", "process.exit(3)"] });
    expect(result).toMatchObject({ status: "MISCONFIGURED", reason: "baseline-test-failed", test_exit: 3 });
    expect(copies.created).toBe(1);
  });

  it("test-command-unrunnable: a missing program, and a command that times out on the baseline", async () => {
    const missing = setup();
    expect(await proveTest({ ...missing.input, testCommand: ["omf-no-such-program-xyz"] })).toMatchObject({ status: "MISCONFIGURED", reason: "test-command-unrunnable" });
    const slow = setup();
    const hang = [process.execPath, "-e", "setInterval(() => {}, 1000)"];
    expect(await proveTest({ ...slow.input, testCommand: hang, timeoutMs: 400 })).toMatchObject({ status: "MISCONFIGURED", reason: "test-command-unrunnable", test_exit: null });
  });

  it("test-command-unrunnable: a command that passes on the baseline and times out on the reverted copy", async () => {
    const script = "const s=require('node:fs').readFileSync('src/calc.mjs','utf8');if(s.includes('a - b'))setInterval(()=>{},1000);else process.exit(0)";
    const { input, copies } = setup();
    const result = await proveTest({ ...input, testCommand: [process.execPath, "-e", script], timeoutMs: 1500 });
    expect(result).toMatchObject({ status: "MISCONFIGURED", reason: "test-command-unrunnable", test_exit: null });
    expect(copies.created).toBe(2);
    expect(copies.disposed).toBe(2);
  });

  it("revert-failed: the reverse patch does not apply to the fresh copy", async () => {
    const { input, copies } = setup(undefined, (index) => (index === 1 ? { applyPatch: async () => false } : {}));
    expect(await proveTest(input)).toMatchObject({ status: "MISCONFIGURED", reason: "revert-failed" });
    expect(copies.disposed).toBe(2);
  });

  it("interrupted: an aborted signal stops the run before any copy is made", async () => {
    const controller = new AbortController();
    controller.abort();
    const { input, copies } = setup();
    expect(await proveTest({ ...input, signal: controller.signal })).toMatchObject({ status: "MISCONFIGURED", reason: "interrupted" });
    expect(copies.created).toBe(0);
  });
});

describe("proveTest cleanup", () => {
  it("disposes the first copy when the second cannot be made", async () => {
    const { input, copies, parent } = setup(undefined, undefined, 1);
    await expect(proveTest(input)).rejects.toThrow("boom");
    expect(copies.created).toBe(1);
    expect(copies.disposed).toBe(1);
    expect(readdirSync(parent)).toEqual([]);
  });

  it("disposes the copy when the command runner throws", async () => {
    const { input, copies } = setup(undefined, () => ({
      run: async () => {
        throw new Error("runner exploded");
      },
    }));
    await expect(proveTest(input)).rejects.toThrow("runner exploded");
    expect(copies.disposed).toBe(1);
  });

  it("a git failure on the quarantine surfaces as a code, not a path", async () => {
    const { input } = setup();
    const missing: GitTarget = { gitDir: join(realTempDir("omf-none-"), "none.git") };
    const failure = await proveTest({ ...input, quarantine: missing }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "gitdir_invalid" });
    expect(String(failure)).not.toContain("none.git");
  });
});
