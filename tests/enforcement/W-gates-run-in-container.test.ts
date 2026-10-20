import { afterEach, describe, expect, it } from "vitest";
import { hostClock, resetLifecycle } from "../../src/container/lifecycle.js";
import type { JudgeConfigDecl } from "../../src/decision/types.js";
import { proveTest } from "../../src/gate/prove-test.js";
import { runGates } from "../../src/gate/run-gates.js";
import { EXIT_0, MemoryRuntime, exit } from "../helpers/memory-runtime.js";
import { TEST_COMMAND, calcFixture } from "../helpers/prove-fixture.js";
import { workCopies } from "../helpers/work-copy-fixture.js";

afterEach(resetLifecycle);

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

  const GATES: JudgeConfigDecl["gates"] = {
    fast: ["npm", "run", "lint"],
    full: ["npm", "test"],
    deep: null,
    required: ["fast"],
  };
  const proveOn = (factory: ReturnType<typeof workCopies>["factory"], fx: ReturnType<typeof calcFixture>) =>
    proveTest({
      quarantine: fx.quarantine,
      base: fx.base,
      head: fx.head,
      testCommand: TEST_COMMAND,
      explicitTestPaths: [],
      copies: factory,
    });

  it("a work copy that stops early on its own is a gate fail and no test status, never a skip", async () => {
    const fx = calcFixture();
    const memory = new MemoryRuntime();
    hostClock.now = () => 0;
    memory.onExec = (name, spec) => {
      if (isTar(spec.argv)) return EXIT_0;
      memory.stopped.add(name);
      hostClock.now = () => 60_000;
      return spec.argv[0] === "npm" ? exit(137) : { kind: "error", code: "EIO", message: "client failed" };
    };
    const { factory } = workCopies(memory);
    const copy = await factory.create({ quarantine: fx.quarantine, sha: fx.head });
    const gated = await runGates(GATES, copy);
    // the non-required gate is a fail too, never a skip that would leave the line GREEN
    expect(gated.values).toMatchObject({ fast: "fail", full: "fail", deep: "skip" });
    expect(gated.verdict.status).toBe("RED");
    await copy.dispose();

    const proven = await proveOn(factory, fx);
    expect(proven).toMatchObject({ status: "MISCONFIGURED", reason: "test-command-unrunnable", test_exit: null });
  });

  it.each([
    ["a required gate", ["fast"] as const],
    ["a gate that is not required", ["full"] as const],
  ])("a work copy the host lost mid-gate stops the line as an infrastructure error (%s)", async (_name, declared) => {
    const fx = calcFixture();
    const memory = new MemoryRuntime();
    hostClock.now = () => 0;
    memory.onExec = (name, spec) => {
      if (isTar(spec.argv)) return EXIT_0;
      if (spec.argv.join(" ") !== (declared[0] === "fast" ? "npm run lint" : "npm test")) return EXIT_0;
      memory.stopped.add(name);
      hostClock.now = () => 1e12; // the lifetime ran out
      return exit(1);
    };
    const { factory } = workCopies(memory);
    const copy = await factory.create({ quarantine: fx.quarantine, sha: fx.head });
    await expect(runGates(GATES, copy)).rejects.toMatchObject({
      name: "GateInfrastructureError",
      code: "workcopy_container_gone",
    });
    await copy.dispose();
  });

  it("negative guard: a test command whose work copy the host lost could not run: MISCONFIGURED with no test status", async () => {
    const fx = calcFixture();
    const memory = new MemoryRuntime();
    hostClock.now = () => 0;
    memory.onExec = (name, spec) => {
      if (isTar(spec.argv)) return EXIT_0;
      memory.stopped.add(name);
      hostClock.now = () => 1e12;
      return exit(1);
    };
    const { factory } = workCopies(memory);
    const proven = await proveOn(factory, fx);
    expect(proven).toMatchObject({ status: "MISCONFIGURED", reason: "test-command-unrunnable" });
    expect(proven.test_exit).toBeNull();
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
