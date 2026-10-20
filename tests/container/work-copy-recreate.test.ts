import { afterEach, describe, expect, it } from "vitest";
import type { ProcessResult } from "../../src/adapters/process-group.js";
import { hostClock, resetLifecycle } from "../../src/container/lifecycle.js";
import type { JudgeConfigDecl } from "../../src/decision/types.js";
import { runGates } from "../../src/gate/run-gates.js";
import { EXIT_0, exit, MemoryRuntime } from "../helpers/memory-runtime.js";
import { calcFixture } from "../helpers/prove-fixture.js";
import { workCopies } from "../helpers/work-copy-fixture.js";

afterEach(resetLifecycle);

const GATES: JudgeConfigDecl["gates"] = { fast: ["ok"], full: null, deep: null, required: ["fast"] };
const OPTIONS = { timeoutMs: 5000, maxOutputBytes: 1024 };
const timeout: ProcessResult = { kind: "timeout", stdout: "", stderr: "" };

/** Makes the copy stale in the three ways a command can: the next command then recreates the container. */
const STALE: ReadonlyArray<readonly [string, (memory: MemoryRuntime, name: string) => ProcessResult]> = [
  [
    "a candidate stop",
    (memory, name) => {
      memory.stopped.add(name);
      hostClock.now = () => 60_000;
      return exit(137);
    },
  ],
  ["a timeout", () => timeout],
  ["the output limit", () => ({ kind: "output_limit", stdout: "", stderr: "" })],
];

async function staleCopy(stale: (memory: MemoryRuntime, name: string) => ProcessResult) {
  const fx = calcFixture();
  const memory = new MemoryRuntime();
  hostClock.now = () => 0;
  const { factory } = workCopies(memory, { build: ["make"] });
  const copy = await factory.create({ quarantine: fx.quarantine, sha: fx.head });
  memory.onExec = (name, spec) => (spec.argv[0] === "stale" ? stale(memory, name) : EXIT_0);
  await copy.run(["stale"], OPTIONS);
  return { memory, copy };
}

describe("a stale work copy whose recreate fails is mapped by cause", () => {
  describe.each(STALE)("after %s", (_name, stale) => {
    it.each([
      ["the candidate build fails", (argv: readonly string[]) => (argv[0] === "make" ? exit(2) : EXIT_0)],
      ["the candidate build times out", (argv: readonly string[]) => (argv[0] === "make" ? timeout : EXIT_0)],
      ["the extract fails", (argv: readonly string[]) => (argv[0] === "tar" ? exit(2) : EXIT_0)],
    ])("%s: that gate fails, never skip, never GREEN", async (_title, answer) => {
      const { memory, copy } = await staleCopy(stale);
      memory.onExec = (_n, spec) => answer(spec.argv);
      const result = await runGates(GATES, copy);
      expect(result.values.fast).toBe("fail");
      expect(result.verdict.status).not.toBe("GREEN");
      await copy.dispose();
    });

    it("the container cannot be created: an infrastructure error, never skip", async () => {
      const { memory, copy } = await staleCopy(stale);
      memory.failCreate = true;
      await expect(runGates(GATES, copy)).rejects.toMatchObject({
        name: "GateInfrastructureError",
        gate: "fast",
        code: "runtime_error",
      });
      await copy.dispose();
    });

    it("the extract times out: an infrastructure error, not the candidate's", async () => {
      const { memory, copy } = await staleCopy(stale);
      memory.onExec = (_n, spec) => (spec.argv[0] === "tar" ? timeout : EXIT_0);
      await expect(runGates(GATES, copy)).rejects.toMatchObject({
        name: "GateInfrastructureError",
        code: "runtime_error",
      });
      await copy.dispose();
    });
  });
});
