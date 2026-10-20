import { afterEach, describe, expect, it } from "vitest";
import type { ProcessResult } from "../../src/adapters/process-group.js";
import { hostClock, resetLifecycle } from "../../src/container/lifecycle.js";
import type { JudgeConfigDecl } from "../../src/decision/types.js";
import { runGates } from "../../src/gate/run-gates.js";
import { proveTest } from "../../src/gate/prove-test.js";
import { EXIT_0, exit, MemoryRuntime } from "../helpers/memory-runtime.js";
import { TEST_COMMAND, calcFixture } from "../helpers/prove-fixture.js";
import { workCopies } from "../helpers/work-copy-fixture.js";

afterEach(resetLifecycle);

const timeout: ProcessResult = { kind: "timeout", stdout: "", stderr: "" };
const clientError: ProcessResult = { kind: "error", code: "EIO", message: "client failed" };
const nullStatus: ProcessResult = { kind: "exited", status: null, signal: "SIGKILL", stdout: "", stderr: "" };
const GATES: JudgeConfigDecl["gates"] = { fast: ["ok"], full: null, deep: null, required: ["fast"] };
const OPTIONS = { timeoutMs: 5000, maxOutputBytes: 1024 };

/**
 * Copy A passes the baseline. Copy B is created (boot 2), gets the revert patch (stale), and its first command recreates the
 * container (boot 3): `boot` answers for that third `make` or `tar`, every other command is clean. A test command that does
 * run in copy B fails, which is what a PROVEN needs, so any wrongly accepted recreate failure shows as PROVEN.
 */
async function proveWithBoot(boot: { make?: ProcessResult; tar?: ProcessResult }) {
  const fx = calcFixture();
  const memory = new MemoryRuntime();
  const seen = { make: 0, tar: 0, test: 0 };
  memory.onExec = (_name, spec) => {
    const head = spec.argv[0];
    if (head === "make" || head === "tar") {
      seen[head] += 1;
      if (seen[head] === 3) return boot[head] ?? EXIT_0;
      return EXIT_0;
    }
    if (head === TEST_COMMAND[0]) {
      seen.test += 1;
      return seen.test === 1 ? EXIT_0 : exit(1);
    }
    return EXIT_0;
  };
  const { factory } = workCopies(memory, { build: ["make"] });
  return proveTest({
    quarantine: fx.quarantine,
    base: fx.base,
    head: fx.head,
    testCommand: TEST_COMMAND,
    explicitTestPaths: [],
    copies: factory,
    timeoutMs: 60_000,
  });
}

describe("a copy B recreate that fails is never a test status", () => {
  it("negative guard: a clean recreate with a failing test is PROVEN", async () => {
    expect((await proveWithBoot({})).status).toBe("PROVEN");
  });

  it.each<readonly [string, { make?: ProcessResult; tar?: ProcessResult }]>([
    ["the build exits 2", { make: exit(2) }],
    ["the build times out", { make: timeout }],
    ["the build gets a client error", { make: clientError }],
    ["the build exits with no status", { make: nullStatus }],
    ["the extract exits 2", { tar: exit(2) }],
    ["the extract gets a client error", { tar: clientError }],
    ["the extract exits with no status", { tar: nullStatus }],
    ["the extract times out", { tar: timeout }],
  ])("%s: MISCONFIGURED, test-command-unrunnable", async (_title, boot) => {
    const result = await proveWithBoot(boot);
    expect(result).toMatchObject({ status: "MISCONFIGURED", reason: "test-command-unrunnable", test_exit: null });
  });
});

/** A copy whose next command recreates the container: made stale by a reverse patch is not needed, a timeout does it. */
async function staleCopy() {
  const fx = calcFixture();
  const memory = new MemoryRuntime();
  const { factory } = workCopies(memory, { build: ["make"] });
  const copy = await factory.create({ quarantine: fx.quarantine, sha: fx.head });
  memory.onExec = (_name, spec) => (spec.argv[0] === "stale" ? timeout : EXIT_0);
  await copy.run(["stale"], OPTIONS);
  return { memory, copy };
}

describe("a stale work copy whose recreate fails, seen by runGates", () => {
  it("a build that exits 2 is a gate fail", async () => {
    const { memory, copy } = await staleCopy();
    memory.onExec = (_name, spec) => (spec.argv[0] === "make" ? exit(2) : EXIT_0);
    expect((await runGates(GATES, copy)).values.fast).toBe("fail");
    await copy.dispose();
  });

  it("a build that exits 2 comes back from run() as the distinct boot_failed result", async () => {
    const { memory, copy } = await staleCopy();
    memory.onExec = (_name, spec) => (spec.argv[0] === "make" ? exit(2) : EXIT_0);
    expect(await copy.run(["ok"], OPTIONS)).toMatchObject({ kind: "error", code: "workcopy_boot_failed" });
    await copy.dispose();
  });

  it.each([
    ["the build gets a client error", { make: clientError }],
    ["the build exits with no status", { make: nullStatus }],
    ["the extract gets a client error", { tar: clientError }],
    ["the extract exits with no status", { tar: nullStatus }],
  ] as ReadonlyArray<readonly [string, { make?: ProcessResult; tar?: ProcessResult }]>)(
    "%s: an infrastructure error, not a candidate fail",
    async (_title, boot) => {
      const { memory, copy } = await staleCopy();
      memory.onExec = (_name, spec) => {
        const head = spec.argv[0];
        return head === "make" || head === "tar" ? (boot[head] ?? EXIT_0) : EXIT_0;
      };
      await expect(runGates(GATES, copy)).rejects.toMatchObject({
        name: "GateInfrastructureError",
        gate: "fast",
        code: "runtime_error",
      });
      await copy.dispose();
    },
  );
});

describe("a stale recreate whose boot exec exits non-zero asks why the container stopped", () => {
  it("a build that exits 1 while inspect fails is an infrastructure error in runGates", async () => {
    const { memory, copy } = await staleCopy();
    memory.onExec = (_name, spec) => {
      if (spec.argv[0] !== "make") return EXIT_0;
      memory.failInspect = true;
      return exit(1);
    };
    await expect(runGates(GATES, copy)).rejects.toMatchObject({
      name: "GateInfrastructureError",
      gate: "fast",
      code: "runtime_error",
    });
    await copy.dispose();
  });

  it("a build that exits 1 while the daemon stops answering is MISCONFIGURED in copy B", async () => {
    const fx = calcFixture();
    const memory = new MemoryRuntime();
    const seen = { make: 0, test: 0 };
    memory.onExec = (_name, spec) => {
      const head = spec.argv[0];
      if (head === "make") {
        seen.make += 1;
        if (seen.make === 3) {
          memory.failInspect = true;
          return exit(1);
        }
        return EXIT_0;
      }
      if (head === TEST_COMMAND[0]) {
        seen.test += 1;
        return seen.test === 1 ? EXIT_0 : exit(1);
      }
      return EXIT_0;
    };
    const { factory } = workCopies(memory, { build: ["make"] });
    const result = await proveTest({
      quarantine: fx.quarantine,
      base: fx.base,
      head: fx.head,
      testCommand: TEST_COMMAND,
      explicitTestPaths: [],
      copies: factory,
      timeoutMs: 60_000,
    });
    expect(result).toMatchObject({ status: "MISCONFIGURED", reason: "test-command-unrunnable", test_exit: null });
  });

  it("a build that exits 2 with the container running stays workcopy_boot_failed (fail)", async () => {
    const { memory, copy } = await staleCopy();
    memory.onExec = (_name, spec) => (spec.argv[0] === "make" ? exit(2) : EXIT_0);
    expect(await copy.run(["ok"], OPTIONS)).toMatchObject({ kind: "error", code: "workcopy_boot_failed" });
    await copy.dispose();
  });
});

/** The container is found stopped early on its own (the host clock is well inside its lifetime) after the test exec answers `answer`. */
const STOPPED_EARLY: ReadonlyArray<readonly [string, ProcessResult]> = [
  ["an exec client error", clientError],
  ["a failing exit", exit(137)],
];

describe.each(STOPPED_EARLY)(
  "a test exec that gets %s while the container is found stopped early",
  (_title, answer) => {
    it("is MISCONFIGURED in copy B, never PROVEN", async () => {
      const fx = calcFixture();
      const memory = new MemoryRuntime();
      hostClock.now = () => 0;
      let tests = 0;
      memory.onExec = (name, spec) => {
        if (spec.argv[0] !== TEST_COMMAND[0]) return EXIT_0;
        tests += 1;
        if (tests === 1) return EXIT_0;
        memory.stopped.add(name);
        hostClock.now = () => 60_000;
        return answer;
      };
      const { factory } = workCopies(memory, { build: ["make"] });
      const result = await proveTest({
        quarantine: fx.quarantine,
        base: fx.base,
        head: fx.head,
        testCommand: TEST_COMMAND,
        explicitTestPaths: [],
        copies: factory,
        timeoutMs: 60_000,
      });
      expect(result).toMatchObject({ status: "MISCONFIGURED", reason: "test-command-unrunnable", test_exit: null });
    });

    it("is a gate fail in runGates", async () => {
      const fx = calcFixture();
      const memory = new MemoryRuntime();
      hostClock.now = () => 0;
      const { factory } = workCopies(memory);
      const copy = await factory.create({ quarantine: fx.quarantine, sha: fx.head });
      memory.onExec = (name, spec) => {
        if (spec.argv[0] !== "ok") return EXIT_0;
        memory.stopped.add(name);
        hostClock.now = () => 60_000;
        return answer;
      };
      const result = await runGates(GATES, copy);
      expect(result.values.fast).toBe("fail");
      expect(result.verdict.status).not.toBe("GREEN");
      await copy.dispose();
    });
  },
);
