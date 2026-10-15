import { describe, expect, it } from "vitest";
import type { ContainerSpec, ImageId } from "../../src/container/spec.js";
import { LeaseOwner, trackRuntime } from "../../src/judge/state.js";
import { MemoryRuntime } from "../helpers/memory-runtime.js";

const IMAGE = `sha256:${"a".repeat(64)}` as ImageId;
const spec = (role: "sut" | "harness", serial: number): ContainerSpec => ({
  name: `omf-${role}-r-20261014T091500Z-ab12-1-${serial}`,
  image: IMAGE,
  labels: { work_id: "w-0123456789ab", run_id: "r-20261014T091500Z-ab12", round: 1, role },
  tmpfs: [],
  limits: { memory_mb: 64, cpus: 1, pids: 16 },
});
const lease = (letter: string): { sut: { id: ImageId } } => ({ sut: { id: `sha256:${letter.repeat(64)}` as ImageId } });

describe("trackRuntime", () => {
  it("tracks every created container until it is removed, and close() removes what is left", async () => {
    const memory = new MemoryRuntime();
    const tracked = trackRuntime(memory);
    const a = await tracked.create(spec("sut", 1));
    await tracked.create(spec("harness", 2));
    expect(tracked.live()).toEqual([spec("sut", 1).name, spec("harness", 2).name]);
    await tracked.remove(a);
    expect(tracked.live()).toEqual([spec("harness", 2).name]);
    tracked.close();
    expect(tracked.live()).toEqual([]);
    expect(memory.calls).toEqual([
      `create ${spec("sut", 1).name}`,
      `create ${spec("harness", 2).name}`,
      `remove ${spec("sut", 1).name}`,
      `removeAllSync ${spec("harness", 2).name}`,
    ]);
    expect(memory.live.size).toBe(0);
  });

  it("a create that fails tracks nothing and asks the daemon to remove the half-made name", async () => {
    const memory = new MemoryRuntime();
    memory.failCreate = true;
    const tracked = trackRuntime(memory);
    await expect(tracked.create(spec("sut", 1))).rejects.toThrow("create failed");
    expect(tracked.live()).toEqual([]);
    expect(memory.calls).toEqual([`removeAllSync ${spec("sut", 1).name}`]);
  });
});

describe("LeaseOwner", () => {
  it("replaces a held lease by removing its image, and dispose() is idempotent", async () => {
    const memory = new MemoryRuntime();
    const owner = new LeaseOwner(memory);
    await owner.adopt(lease("a"));
    await owner.adopt(lease("b"));
    expect(memory.calls).toEqual([`rmi sha256:${"a".repeat(64)}`]);
    await owner.dispose();
    await owner.dispose();
    expect(memory.calls).toEqual([`rmi sha256:${"a".repeat(64)}`, `rmi sha256:${"b".repeat(64)}`]);
    expect(owner.current()).toBeNull();
  });

  it("keeps the lease when the removal fails, so a retry or the next sweep can still find it", async () => {
    const memory = new MemoryRuntime();
    const owner = new LeaseOwner(memory);
    await owner.adopt(lease("a"));
    memory.failImageRemoval = true;
    await expect(owner.dispose()).rejects.toThrow("image removal failed");
    expect(owner.current()).not.toBeNull();
    memory.failImageRemoval = false;
    await owner.dispose();
    expect(owner.current()).toBeNull();
  });
});
