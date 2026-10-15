import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ProcessResult } from "../adapters/process-group.js";
import type { PinnedImage } from "../container/image-ref.js";
import type { ContainerHandle, ContainerRuntime, ExecSpec, ImageInfo, OwnedResource } from "../container/runtime.js";
import type { ContainerRole, ContainerSpec, ImageId } from "../container/spec.js";
import { registerCleanup } from "../core/cleanup-registry.js";

/** A runtime that remembers every container it made and can remove them without a handle. */
export interface TrackedRuntime extends ContainerRuntime {
  /** Names created through this wrapper and not yet removed, in creation order. */
  live(): string[];
  /** Removes every container still live, by name. Synchronous and idempotent, so a `finally` and a signal handler may both call it. */
  close(): void;
}

class Tracker implements TrackedRuntime {
  private readonly names = new Set<string>();
  private unregister: (() => void) | null = null;

  constructor(private readonly inner: ContainerRuntime) {}

  get context(): string | null {
    return this.inner.context;
  }

  live(): string[] {
    return [...this.names];
  }

  close(): void {
    const names = [...this.names];
    if (names.length > 0) this.inner.removeAllSync(names);
    for (const name of names) this.forget(name);
  }

  /** The signal handler is registered while at least one container is live and taken off again when the last one is gone. */
  private track(name: string): void {
    this.names.add(name);
    this.unregister ??= registerCleanup(() => this.inner.removeAllSync([...this.names]));
  }

  private forget(name: string): void {
    this.names.delete(name);
    if (this.names.size === 0) {
      this.unregister?.();
      this.unregister = null;
    }
  }

  endpoint(): ReturnType<ContainerRuntime["endpoint"]> {
    return this.inner.endpoint();
  }

  info(): ReturnType<ContainerRuntime["info"]> {
    return this.inner.info();
  }

  ensureImage(ref: PinnedImage): Promise<ImageInfo> {
    return this.inner.ensureImage(ref);
  }

  imageInfo(idOrRef: string): Promise<ImageInfo> {
    return this.inner.imageInfo(idOrRef);
  }

  build(spec: Parameters<ContainerRuntime["build"]>[0]): Promise<ImageInfo> {
    return this.inner.build(spec);
  }

  /** The name is tracked before the daemon is asked: a kill between `docker create` and its reply still removes the container. */
  async create(spec: ContainerSpec): Promise<ContainerHandle> {
    this.track(spec.name);
    try {
      return await this.inner.create(spec);
    } catch (error) {
      this.inner.removeAllSync([spec.name]);
      this.forget(spec.name);
      throw error;
    }
  }

  inspect(handle: ContainerHandle): Promise<unknown> {
    return this.inner.inspect(handle);
  }

  start(handle: ContainerHandle): Promise<void> {
    return this.inner.start(handle);
  }

  exec(handle: ContainerHandle, spec: ExecSpec): Promise<ProcessResult> {
    return this.inner.exec(handle, spec);
  }

  /** Forgotten only after the daemon confirmed: a failed removal stays tracked for `close()` and for a signal. */
  async remove(handle: ContainerHandle): Promise<void> {
    await this.inner.remove(handle);
    this.forget(handle.name);
  }

  removeImage(id: ImageId): Promise<void> {
    return this.inner.removeImage(id);
  }

  listOwned(filter: Parameters<ContainerRuntime["listOwned"]>[0]): Promise<OwnedResource[]> {
    return this.inner.listOwned(filter);
  }

  removeAllSync(names: readonly string[]): void {
    this.inner.removeAllSync(names);
    for (const name of names) this.forget(name);
  }
}

/**
 * One wrapper per line. Everything that creates containers (the judge round, the harness, every work copy) is given this runtime,
 * so one registration with the shared cleanup registry covers all of them, including roles added later.
 */
export function trackRuntime(inner: ContainerRuntime): TrackedRuntime {
  return new Tracker(inner);
}

/** What a lease needs to be disposed: the built SUT image. `ImageLease` (round.ts) satisfies it. */
export interface DisposableLease {
  readonly sut: { readonly id: ImageId };
}

/**
 * Removes the per-round SUT image. The harness image is cached by context hash and reused across rounds, so it stays;
 * `W-judge-leak-sweep` pins that exemption.
 */
export async function disposeImages(
  runtime: Pick<ContainerRuntime, "removeImage">,
  lease: DisposableLease,
): Promise<void> {
  await runtime.removeImage(lease.sut.id);
}

/**
 * Holds the one image lease of a line. The SUT image lives from S4 to S6 of a round, so a new round's lease replaces
 * the old one, and the line's `dispose()` removes the last. A removal that fails leaves the lease held: the error reaches the
 * caller and the next run's `sweepOrphans` finds the image by its run id.
 */
export class LeaseOwner {
  private held: DisposableLease | null = null;

  constructor(private readonly runtime: Pick<ContainerRuntime, "removeImage">) {}

  current(): DisposableLease | null {
    return this.held;
  }

  async adopt(lease: DisposableLease): Promise<void> {
    await this.dispose();
    this.held = lease;
  }

  async dispose(): Promise<void> {
    const lease = this.held;
    if (lease === null) return;
    await disposeImages(this.runtime, lease);
    this.held = null;
  }
}

export interface SweepInput {
  runtime: Pick<ContainerRuntime, "listOwned" | "remove" | "removeImage">;
  /** `<project>/items/<work_id>`; its `runs/` directory names every run this item ever started. */
  itemDir: string;
  currentRunId: string;
}

export interface SweepResult {
  containers: number;
  images: number;
  /** Earlier runs whose host build-context directory (`runs/<run_id>/judge`) was removed. */
  staging: number;
}

const ROLE_OF_NAME = /^omf-(sut|harness|workcopy)-/;

/**
 * Removes what earlier runs of THIS work item left in the daemon and on disk. The item claim allows one run at a time, so any
 * other run of the item is an orphan. Selection is by run id: a run id belongs to exactly one item, and `<item>/runs/` lists this
 * item's runs, so another item's resources are never selected. Only per-round SUT images (`omf-sut:`) are removed; the cached
 * harness image is kept. Containers go first, then host directories. A resource whose name does not match the container name
 * pattern is left alone.
 */
export async function sweepOrphans(input: SweepInput): Promise<SweepResult> {
  const runsDir = join(input.itemDir, "runs");
  const earlier = new Set(existsSync(runsDir) ? readdirSync(runsDir) : []);
  earlier.delete(input.currentRunId);
  const result: SweepResult = { containers: 0, images: 0, staging: 0 };
  for (const resource of await input.runtime.listOwned({ run_id: null })) {
    if (!earlier.has(resource.run_id)) continue;
    if (resource.kind === "container") {
      const role = ROLE_OF_NAME.exec(resource.name)?.[1] as ContainerRole | undefined;
      if (role === undefined) continue;
      await input.runtime.remove({ name: resource.name, id: resource.name, role });
      result.containers += 1;
    } else if (resource.name.startsWith("omf-sut:")) {
      await input.runtime.removeImage(resource.name as ImageId);
      result.images += 1;
    }
  }
  for (const runId of earlier) {
    const judgeDir = join(runsDir, runId, "judge");
    if (!existsSync(judgeDir)) continue;
    rmSync(judgeDir, { recursive: true, force: true });
    result.staging += 1;
  }
  return result;
}
