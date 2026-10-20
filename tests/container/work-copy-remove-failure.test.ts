import { afterEach, describe, expect, it } from "vitest";
import type { ProcessResult } from "../../src/adapters/process-group.js";
import { hostClock, markHostEnded, resetLifecycle } from "../../src/container/lifecycle.js";
import type { JudgeConfigDecl } from "../../src/decision/types.js";
import { GateInfrastructureError, runGates } from "../../src/gate/run-gates.js";
import { EXIT_0, exit, MemoryRuntime } from "../helpers/memory-runtime.js";
import { calcFixture } from "../helpers/prove-fixture.js";
import { workCopies } from "../helpers/work-copy-fixture.js";

afterEach(resetLifecycle);

/** `fast` is required and passes; `full` is declared but not required, and is the one whose container fails. */
const GATES: JudgeConfigDecl["gates"] = { fast: ["ok"], full: ["gate"], deep: null, required: ["fast"] };

/** The decided result of `gate`, with the daemon refusing to remove the container afterwards. */
async function runWithFailingRemove(answer: (memory: MemoryRuntime, name: string) => ProcessResult): Promise<{
  memory: MemoryRuntime;
  outcome: Promise<Awaited<ReturnType<typeof runGates>>>;
  dispose: () => Promise<void>;
}> {
  const fx = calcFixture();
  const memory = new MemoryRuntime();
  hostClock.now = () => 0;
  const { factory } = workCopies(memory);
  const copy = await factory.create({ quarantine: fx.quarantine, sha: fx.head });
  memory.onExec = (name, spec) => {
    if (spec.argv[0] !== "gate") return EXIT_0;
    memory.failRemove = true;
    return answer(memory, name);
  };
  const outcome = runGates(GATES, copy);
  return {
    memory,
    outcome,
    dispose: async () => {
      memory.failRemove = false;
      await copy.dispose();
    },
  };
}

describe("a decided work copy result survives a failed removal of its container", () => {
  it.each([
    ["a timeout", () => ({ kind: "timeout", stdout: "", stderr: "" }) as ProcessResult],
    ["the output limit", () => ({ kind: "output_limit", stdout: "", stderr: "" }) as ProcessResult],
    [
      "a container that stopped early on its own",
      (memory: MemoryRuntime, name: string) => {
        memory.stopped.add(name);
        hostClock.now = () => 60_000;
        return exit(137);
      },
    ],
    [
      "a container that stopped early on its own with an exec client error",
      (memory: MemoryRuntime, name: string) => {
        memory.stopped.add(name);
        hostClock.now = () => 60_000;
        return { kind: "error", code: "EIO", message: "client failed" } as ProcessResult;
      },
    ],
  ])("%s is a failing gate, never a skip and never GREEN", async (_name, answer) => {
    const run = await runWithFailingRemove(answer);
    const result = await run.outcome;
    expect(result.values).toMatchObject({ fast: "pass", full: "fail" });
    expect(result.verdict.status).not.toBe("GREEN");
    await run.dispose();
  });

  it.each([
    [
      "a container the host lost",
      (memory: MemoryRuntime, name: string) => {
        markHostEnded(name);
        memory.stopped.add(name);
        return exit(137);
      },
      "workcopy_container_gone",
    ],
    [
      "an exit with no status",
      () => ({ kind: "exited", status: null, signal: "SIGKILL", stdout: "", stderr: "" }) as ProcessResult,
      "workcopy_exit_unknown",
    ],
  ])("%s stops the line as an infrastructure error, never a skip", async (_name, answer, code) => {
    const run = await runWithFailingRemove(answer);
    await expect(run.outcome).rejects.toBeInstanceOf(GateInfrastructureError);
    await expect(run.outcome).rejects.toMatchObject({ gate: "full", code });
    await run.dispose();
  });

  it("keeps the container reachable by name for abortSync after the failed removal", async () => {
    const fx = calcFixture();
    const memory = new MemoryRuntime();
    const { factory } = workCopies(memory);
    const copy = await factory.create({ quarantine: fx.quarantine, sha: fx.head });
    const name = memory.specs[0]?.name;
    memory.onExec = (_name, spec) => (spec.argv[0] === "gate" ? { kind: "timeout", stdout: "", stderr: "" } : EXIT_0);
    memory.failRemove = true;
    expect((await copy.run(["gate"], { timeoutMs: 5000, maxOutputBytes: 1024 })).kind).toBe("timeout");
    memory.failRemove = false;
    copy.abortSync();
    expect(memory.calls.at(-1)).toBe(`removeAllSync ${name}`);
  });

  it("a docker client error against a container that still runs is an infrastructure error, never a skip", async () => {
    const fx = calcFixture();
    const memory = new MemoryRuntime();
    const { factory } = workCopies(memory);
    const copy = await factory.create({ quarantine: fx.quarantine, sha: fx.head });
    memory.onExec = (_name, spec) =>
      spec.argv[0] === "gate" ? { kind: "error", code: "ENOENT", message: "spawn docker ENOENT" } : EXIT_0;
    await expect(runGates(GATES, copy)).rejects.toMatchObject({
      name: "GateInfrastructureError",
      code: "runtime_error",
    });
    await copy.dispose();
  });
});
