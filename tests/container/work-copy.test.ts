import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostClock, LIFETIME_SLACK_MS, markHostEnded, resetLifecycle } from "../../src/container/lifecycle.js";
import { MeasureError, NotGoldenError } from "../../src/container/measure.js";
import { roleTmpfs, WORKCOPY_GATE_EXEC_S, WORKCOPY_GATE_EXECS } from "../../src/container/spec.js";
import { ContainerWorkCopyFactory, type Launch, WorkCopyError } from "../../src/container/work-copy.js";
import { revertPatch } from "../../src/git/ops.js";
import { EXIT_0, exit, MemoryRuntime } from "../helpers/memory-runtime.js";
import { calcFixture } from "../helpers/prove-fixture.js";
import { workCopies, workCopyDeps } from "../helpers/work-copy-fixture.js";

afterEach(resetLifecycle);

const OPTIONS = { timeoutMs: 5000, maxOutputBytes: 1024 * 1024 };
const bytes = (stdin: string | Buffer | undefined): Buffer => (Buffer.isBuffer(stdin) ? stdin : Buffer.alloc(0));

describe("ContainerWorkCopyFactory (spec section 4.8)", () => {
  it("hands the tree to a workcopy container only as tar on stdin", async () => {
    const fx = calcFixture();
    const memory = new MemoryRuntime();
    const { factory } = workCopies(memory);
    const copy = await factory.create({ quarantine: fx.quarantine, sha: fx.head });
    expect(memory.execs).toHaveLength(1);
    const [extract] = memory.execs;
    expect(extract?.argv).toEqual(["tar", "-x", "-C", "/work"]);
    expect(bytes(extract?.stdin).includes("a + b")).toBe(true);
    const spec = memory.specs[0];
    expect(spec?.labels.role).toBe("workcopy");
    expect(spec?.name).toMatch(/^omf-workcopy-r-20261015T090000Z-ab12-1-[0-9]+$/);
    expect(spec?.tmpfs.map((tmpfs) => tmpfs.destination)).toEqual(["/tmp", "/work"]);
    await copy.dispose();
    expect(memory.live.size).toBe(0);
  });

  it("runs the declared build once after extraction and before any command, in /work", async () => {
    const fx = calcFixture();
    const memory = new MemoryRuntime();
    const { factory } = workCopies(memory, { build: ["make", "all"] });
    const copy = await factory.create({ quarantine: fx.quarantine, sha: fx.head });
    await copy.run(["echo", "hi"], OPTIONS);
    expect(memory.execs.map((e) => e.argv)).toEqual([
      ["tar", "-x", "-C", "/work"],
      ["make", "all"],
      ["echo", "hi"],
    ]);
    expect(memory.execs.map((e) => e.workdir)).toEqual([undefined, "/work", "/work"]);
    await copy.dispose();
  });

  it("a failing build removes the container and reports build_failed", async () => {
    const fx = calcFixture();
    const memory = new MemoryRuntime();
    memory.onExec = (_name, spec) => (spec.argv[0] === "make" ? exit(2) : EXIT_0);
    const { factory } = workCopies(memory, { build: ["make"] });
    const failure = factory.create({ quarantine: fx.quarantine, sha: fx.head });
    await expect(failure).rejects.toBeInstanceOf(WorkCopyError);
    await expect(failure).rejects.toMatchObject({ code: "build_failed" });
    expect(memory.live.size).toBe(0);
  });

  it("isClean is true on creation and false after a host-side change to the staged tree", async () => {
    const fx = calcFixture();
    const memory = new MemoryRuntime();
    const { factory, stageRoot } = workCopies(memory);
    const copy = await factory.create({ quarantine: fx.quarantine, sha: fx.head });
    expect(await copy.isClean()).toBe(true);
    writeFileSync(join(stageRoot, copy.id, "tree", "stray.txt"), "x");
    expect(await copy.isClean()).toBe(false);
    await copy.dispose();
  });

  it("applyPatch marks the copy stale: the next run recreates the container, re-extracts the patched tree and re-builds", async () => {
    const fx = calcFixture();
    const memory = new MemoryRuntime();
    const { factory } = workCopies(memory, { build: ["make"] });
    const copy = await factory.create({ quarantine: fx.quarantine, sha: fx.head });
    const patch = await revertPatch(fx.quarantine, fx.base, fx.head, ["src/calc.mjs"]);
    expect(await copy.applyPatch(patch, { reverse: true })).toBe(true);
    await copy.run(["echo"], OPTIONS);
    expect(memory.execs.map((e) => e.argv[0])).toEqual(["tar", "make", "tar", "make", "echo"]);
    const names = memory.execs.map((e) => e.name);
    expect(names[0]).toBe(names[1]);
    expect(names[2]).toBe(names[3]);
    expect(names[2]).toBe(names[4]);
    expect(names[2]).not.toBe(names[0]);
    expect(memory.calls).toContain(`remove ${names[0]}`);
    expect(bytes(memory.execs[0]?.stdin).includes("a + b")).toBe(true);
    expect(bytes(memory.execs[2]?.stdin).includes("a - b")).toBe(true);
    await copy.dispose();
    expect(memory.live.size).toBe(0);
  });

  it("a timeout removes the container by name, and the next command runs in a fresh one", async () => {
    const fx = calcFixture();
    const memory = new MemoryRuntime();
    memory.onExec = (_name, spec) => (spec.argv[0] === "slow" ? { kind: "timeout", stdout: "", stderr: "" } : EXIT_0);
    const { factory } = workCopies(memory);
    const copy = await factory.create({ quarantine: fx.quarantine, sha: fx.head });
    const first = memory.specs[0]?.name;
    expect((await copy.run(["slow"], OPTIONS)).kind).toBe("timeout");
    expect(memory.calls).toContain(`remove ${first}`);
    await copy.run(["echo"], OPTIONS);
    expect(memory.execs.map((e) => e.argv[0])).toEqual(["tar", "slow", "tar", "echo"]);
    expect(memory.execs.at(-1)?.name).not.toBe(first);
    await copy.dispose();
  });

  it("replaces the container with a fresh one once its gate exec budget is spent, so its lifetime is never outrun", async () => {
    const fx = calcFixture();
    const memory = new MemoryRuntime();
    const { factory } = workCopies(memory, { build: ["make"] });
    const copy = await factory.create({ quarantine: fx.quarantine, sha: fx.head });
    for (let n = 0; n < WORKCOPY_GATE_EXECS; n += 1) await copy.run(["echo", String(n)], OPTIONS);
    const gates = memory.execs.filter((e) => e.argv[0] === "echo");
    expect(new Set(gates.map((e) => e.name)).size).toBe(1);
    expect(memory.specs).toHaveLength(1);
    await copy.run(["echo", "next"], OPTIONS);
    expect(memory.specs).toHaveLength(2);
    expect(memory.live.size).toBe(1);
    const last = memory.execs.at(-1);
    expect(last?.argv).toEqual(["echo", "next"]);
    expect(last?.name).not.toBe(gates[0]?.name);
    // the fresh container is booted like the first: extract, then build, before the command, and its budget starts again
    expect(memory.execs.slice(-3).map((e) => e.argv[0])).toEqual(["tar", "make", "echo"]);
    for (let n = 1; n < WORKCOPY_GATE_EXECS; n += 1) await copy.run(["echo", "again"], OPTIONS);
    expect(memory.specs).toHaveLength(2);
    await copy.dispose();
    expect(memory.live.size).toBe(0);
  });

  it("clamps an injected gate timeout to the cap the lifetime is sized from", async () => {
    const fx = calcFixture();
    const memory = new MemoryRuntime();
    const timeouts: number[] = [];
    memory.onExec = (_name, spec) => {
      timeouts.push(spec.timeoutMs);
      return EXIT_0;
    };
    const { factory } = workCopies(memory);
    const copy = await factory.create({ quarantine: fx.quarantine, sha: fx.head });
    await copy.run(["echo"], { timeoutMs: 3_600_000, maxOutputBytes: 1024 });
    await copy.run(["echo"], { timeoutMs: 5000, maxOutputBytes: 1024 });
    expect(timeouts.slice(-2)).toEqual([WORKCOPY_GATE_EXEC_S * 1000, 5000]);
    await copy.dispose();
  });

  /** The host clock reads the start, then jumps to the moment the container's lifetime has run out. */
  const lifetimeRunsOut = (memory: MemoryRuntime, name: string): void => {
    const lifetime = memory.specs.find((spec) => spec.name === name)?.lifetime_s ?? 0;
    hostClock.now = () => lifetime * 1000 - LIFETIME_SLACK_MS;
  };

  it.each([
    ["negative guard: status 1", exit(1)],
    ["negative guard: status 125", exit(125)],
    ["negative guard: status 137", exit(137)],
    ["an exec client error", { kind: "error", code: "EIO", message: "client failed" } as const],
  ])(
    "a failed exec (%s) in a container whose lifetime ran out is an infrastructure error, and the next command gets a fresh one",
    async (_name, answer) => {
      const fx = calcFixture();
      const memory = new MemoryRuntime();
      hostClock.now = () => 0;
      memory.onExec = (name, spec) => {
        if (spec.argv[0] !== "gate") return EXIT_0;
        memory.stopped.add(name);
        lifetimeRunsOut(memory, name);
        return answer;
      };
      const { factory } = workCopies(memory);
      const copy = await factory.create({ quarantine: fx.quarantine, sha: fx.head });
      const first = memory.specs[0]?.name;
      expect(await copy.run(["gate"], OPTIONS)).toEqual({
        kind: "error",
        code: "workcopy_container_gone",
        message: "container_gone",
      });
      expect(memory.calls).toContain(`remove ${first}`);
      memory.onExec = () => EXIT_0;
      expect((await copy.run(["echo"], OPTIONS)).kind).toBe("exited");
      expect(memory.specs).toHaveLength(2);
      await copy.dispose();
    },
  );

  it("negative guard: a failed inspect after a non-zero exit is an infrastructure error, never the gate's result", async () => {
    const fx = calcFixture();
    const memory = new MemoryRuntime();
    const { factory } = workCopies(memory);
    const copy = await factory.create({ quarantine: fx.quarantine, sha: fx.head });
    memory.onExec = (_name, spec) => {
      if (spec.argv[0] === "gate") memory.failInspect = true;
      return spec.argv[0] === "gate" ? exit(1) : EXIT_0;
    };
    expect(await copy.run(["gate"], OPTIONS)).toMatchObject({ kind: "error", code: "workcopy_container_gone" });
    memory.failInspect = false;
    await copy.dispose();
  });

  it("negative guard: a container the host removed during the command is an infrastructure error", async () => {
    const fx = calcFixture();
    const memory = new MemoryRuntime();
    const { factory } = workCopies(memory);
    const copy = await factory.create({ quarantine: fx.quarantine, sha: fx.head });
    memory.onExec = (name, spec) => {
      if (spec.argv[0] !== "gate") return EXIT_0;
      markHostEnded(name);
      memory.stopped.add(name);
      return exit(137);
    };
    expect(await copy.run(["gate"], OPTIONS)).toMatchObject({ kind: "error", code: "workcopy_container_gone" });
    await copy.dispose();
  });

  describe("a container that stopped early on its own is the command's failure", () => {
    it.each([
      ["status 1", exit(1), 1],
      ["status 137", exit(137), 137],
      ["an exec client error", { kind: "error", code: "EIO", message: "client failed" } as const, 137],
    ])("%s comes back as a failed exit, and the next command gets a fresh container", async (_name, answer, status) => {
      const fx = calcFixture();
      const memory = new MemoryRuntime();
      hostClock.now = () => 0;
      const { factory } = workCopies(memory);
      const copy = await factory.create({ quarantine: fx.quarantine, sha: fx.head });
      memory.onExec = (name, spec) => {
        if (spec.argv[0] !== "gate") return EXIT_0;
        memory.stopped.add(name);
        hostClock.now = () => 60_000;
        return answer;
      };
      expect(await copy.run(["gate"], OPTIONS)).toMatchObject({ kind: "exited", status });
      memory.onExec = () => EXIT_0;
      expect((await copy.run(["echo"], OPTIONS)).kind).toBe("exited");
      expect(memory.specs).toHaveLength(2);
      await copy.dispose();
    });

    it("an OOM kill (State.OOMKilled true) is the command's failure", async () => {
      const fx = calcFixture();
      const memory = new MemoryRuntime();
      hostClock.now = () => 0;
      const { factory } = workCopies(memory);
      const copy = await factory.create({ quarantine: fx.quarantine, sha: fx.head });
      memory.onExec = (name) => {
        memory.stopped.add(name);
        memory.stopState.set(name, { OOMKilled: true, ExitCode: 137 });
        return exit(137);
      };
      expect(await copy.run(["gate"], OPTIONS)).toMatchObject({ kind: "exited", status: 137 });
      await copy.dispose();
    });
  });

  it.each([
    ["running", false],
    ["stopped", true],
  ])("an exit with no status is an error result whatever the container state (%s)", async (_state, stopped) => {
    const fx = calcFixture();
    const memory = new MemoryRuntime();
    hostClock.now = () => 0;
    const { factory } = workCopies(memory);
    const copy = await factory.create({ quarantine: fx.quarantine, sha: fx.head });
    memory.onExec = (name, spec) => {
      if (spec.argv[0] !== "gate") return EXIT_0;
      if (stopped) memory.stopped.add(name);
      return { kind: "exited", status: null, signal: "SIGKILL", stdout: "", stderr: "" };
    };
    expect(await copy.run(["gate"], OPTIONS)).toEqual({
      kind: "error",
      code: "workcopy_exit_unknown",
      message: "exit_unknown",
    });
    memory.onExec = () => EXIT_0;
    expect((await copy.run(["echo"], OPTIONS)).kind).toBe("exited");
    expect(memory.specs).toHaveLength(2);
    await copy.dispose();
  });

  it("a non-zero exit from a container that is still running is the gate's own result", async () => {
    const fx = calcFixture();
    const memory = new MemoryRuntime();
    memory.onExec = (_name, spec) => (spec.argv[0] === "gate" ? exit(1) : EXIT_0);
    const { factory } = workCopies(memory);
    const copy = await factory.create({ quarantine: fx.quarantine, sha: fx.head });
    expect(await copy.run(["gate"], OPTIONS)).toMatchObject({ kind: "exited", status: 1 });
    expect(memory.specs).toHaveLength(1);
    await copy.dispose();
  });

  it("a recreate whose extract fails comes back as a failing exit, not an exception", async () => {
    const fx = calcFixture();
    const memory = new MemoryRuntime();
    const { factory } = workCopies(memory);
    const copy = await factory.create({ quarantine: fx.quarantine, sha: fx.head });
    const patch = await revertPatch(fx.quarantine, fx.base, fx.head, ["src/calc.mjs"]);
    await copy.applyPatch(patch, { reverse: true });
    memory.onExec = () => exit(1);
    expect(await copy.run(["echo"], OPTIONS)).toEqual({
      kind: "exited",
      status: 1,
      signal: null,
      stdout: "",
      stderr: "",
    });
    expect(memory.live.size).toBe(0);
    await copy.dispose();
  });

  it("a container that is not golden is never run", async () => {
    const fx = calcFixture();
    const memory = new MemoryRuntime();
    const launch: Launch = async () => {
      throw new NotGoldenError(["network_not_none"]);
    };
    const { factory } = workCopies(memory, { launch });
    await expect(factory.create({ quarantine: fx.quarantine, sha: fx.head })).rejects.toMatchObject({
      code: "not_golden",
    });
    expect(memory.execs).toEqual([]);
  });

  it("the default launch creates a workcopy container and measures it before anything is extracted", async () => {
    const fx = calcFixture();
    const memory = new MemoryRuntime(); // its inspect answers {}: the measurement cannot parse it and removes the container
    const factory = new ContainerWorkCopyFactory(workCopyDeps(memory));
    await expect(factory.create({ quarantine: fx.quarantine, sha: fx.head })).rejects.toBeInstanceOf(MeasureError);
    expect(memory.specs[0]?.labels.role).toBe("workcopy");
    expect(memory.specs[0]?.tmpfs.find((tmpfs) => tmpfs.destination === "/work")).toMatchObject({ exec: true });
    expect(memory.specs[0]?.tmpfs).toEqual(
      roleTmpfs("workcopy", { kind: "judge", judge: workCopyDeps(memory).config }),
    );
    expect(memory.execs).toEqual([]);
    expect(memory.live.size).toBe(0);
  });

  it("abortSync removes the container by name and the staging directory, and dispose after it is harmless", async () => {
    const fx = calcFixture();
    const memory = new MemoryRuntime();
    const { factory, stageRoot } = workCopies(memory);
    const copy = await factory.create({ quarantine: fx.quarantine, sha: fx.head });
    const name = memory.specs[0]?.name;
    copy.abortSync();
    expect(memory.calls.at(-1)).toBe(`removeAllSync ${name}`);
    expect(existsSync(join(stageRoot, copy.id))).toBe(false);
    await copy.dispose();
  });
});
