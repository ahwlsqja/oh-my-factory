import { describe, expect, it } from "vitest";
import type { JudgeConfigDecl } from "../../src/decision/types.js";
import { proveTest } from "../../src/gate/prove-test.js";
import { runGates } from "../../src/gate/run-gates.js";
import { EXIT_0, MemoryRuntime, exit } from "../helpers/memory-runtime.js";
import { TEST_COMMAND, calcFixture } from "../helpers/prove-fixture.js";
import { workCopies } from "../helpers/work-copy-fixture.js";

const bytes = (stdin: string | Buffer | undefined): Buffer => (Buffer.isBuffer(stdin) ? stdin : Buffer.alloc(0));
const isTar = (argv: readonly string[]): boolean => argv[0] === "tar";

// M3e-D7, M3f-D11: the declared gates and the test command run through the container copy and nowhere else. The commands are
// recorded as `docker exec` requests on the container; no host process is started by any code under test here.
describe("W-gates-run-in-container", () => {
  it("runGates sends each declared gate to the container, in /work, with the declared argv", async () => {
    const fx = calcFixture();
    const memory = new MemoryRuntime();
    const { factory } = workCopies(memory);
    const copy = await factory.create({ quarantine: fx.quarantine, sha: fx.head });
    const gates: JudgeConfigDecl["gates"] = {
      fast: ["npm", "run", "lint"],
      full: ["npm", "test"],
      deep: null,
      required: ["fast", "full"],
    };
    const result = await runGates(gates, copy);
    expect(result.verdict.status).toBe("GREEN");
    const gateExecs = memory.execs.filter((e) => !isTar(e.argv));
    expect(gateExecs.map((e) => e.argv)).toEqual([
      ["npm", "run", "lint"],
      ["npm", "test"],
    ]);
    expect(gateExecs.every((e) => e.workdir === "/work")).toBe(true);
    await copy.dispose();
  });

  it("proveTest proves a change through container copies: the reverted copy receives the reverted tree", async () => {
    const fx = calcFixture();
    const memory = new MemoryRuntime();
    let testRuns = 0;
    memory.onExec = (_name, spec) => (isTar(spec.argv) ? EXIT_0 : exit(testRuns++ === 0 ? 0 : 1));
    const { factory } = workCopies(memory);
    const result = await proveTest({
      quarantine: fx.quarantine,
      base: fx.base,
      head: fx.head,
      testCommand: TEST_COMMAND,
      explicitTestPaths: [],
      copies: factory,
    });
    expect(result).toEqual({ status: "PROVEN", reason: null, test_exit: 1, non_test_paths: 1, test_paths: 1 });
    const tars = memory.execs.filter((e) => isTar(e.argv)).map((e) => bytes(e.stdin));
    expect(tars).toHaveLength(3); // baseline, revert copy, revert copy re-extracted after the patch
    expect(tars[0]?.includes("a + b")).toBe(true);
    expect(tars[2]?.includes("a - b")).toBe(true);
    expect(tars[2]?.includes("a + b")).toBe(false);
    expect(memory.live.size).toBe(0);
  });

  it("proveTest reports FAILED when the test also passes on the reverted tree", async () => {
    const fx = calcFixture();
    const memory = new MemoryRuntime();
    const { factory } = workCopies(memory);
    const result = await proveTest({
      quarantine: fx.quarantine,
      base: fx.base,
      head: fx.head,
      testCommand: TEST_COMMAND,
      explicitTestPaths: [],
      copies: factory,
    });
    expect(result).toMatchObject({ status: "FAILED", reason: "test-passed-without-fix", test_exit: 0 });
    expect(memory.live.size).toBe(0);
  });
});
