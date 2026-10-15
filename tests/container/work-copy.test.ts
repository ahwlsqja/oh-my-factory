import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MeasureError, NotGoldenError } from "../../src/container/measure.js";
import { roleTmpfs } from "../../src/container/spec.js";
import { ContainerWorkCopyFactory, type Launch, WorkCopyError } from "../../src/container/work-copy.js";
import { revertPatch } from "../../src/git/ops.js";
import { EXIT_0, exit, MemoryRuntime } from "../helpers/memory-runtime.js";
import { calcFixture } from "../helpers/prove-fixture.js";
import { workCopies, workCopyDeps } from "../helpers/work-copy-fixture.js";

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

  it("a recreate that fails comes back as an error result, not an exception", async () => {
    const fx = calcFixture();
    const memory = new MemoryRuntime();
    const { factory } = workCopies(memory);
    const copy = await factory.create({ quarantine: fx.quarantine, sha: fx.head });
    const patch = await revertPatch(fx.quarantine, fx.base, fx.head, ["src/calc.mjs"]);
    await copy.applyPatch(patch, { reverse: true });
    memory.onExec = () => exit(1);
    expect(await copy.run(["echo"], OPTIONS)).toEqual({
      kind: "error",
      code: "workcopy_extract_failed",
      message: "extract_failed",
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
    expect(memory.specs[0]?.tmpfs).toEqual(roleTmpfs("workcopy", workCopyDeps(memory).config));
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
