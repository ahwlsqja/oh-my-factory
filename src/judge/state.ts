import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ProcessResult } from "../adapters/process-group.js";
import type { PinnedImage } from "../container/image-ref.js";
import type { ContainerHandle, ContainerRuntime, ExecSpec, ImageInfo, OwnedResource } from "../container/runtime.js";
import { removeStagingDirs } from "../container/item-sweep.js";
import { assertName, type ContainerRole, type ContainerSpec, type ImageId } from "../container/spec.js";
import { registerCleanup } from "../core/cleanup-registry.js";
import { isLockHeld, sealLockFile } from "../core/lock.js";

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
  /** The item's id: only containers whose `omf.work` label is this item are selected, since two items can share a run id. */
  workId: string;
}

export interface SweepResult {
  containers: number;
  images: number;
  /** Earlier runs whose host build-context directory (`runs/<run_id>/judge`) was removed. */
  staging: number;
  /** Labelled containers of earlier runs whose name is off the container name pattern: left in place and reported, never removed. */
  skipped: string[];
}

const ROLE_OF_NAME = /^omf-(sut|harness|workcopy|implementer|author)-/;

/**
 * Removes what earlier runs of THIS work item left in the daemon and on disk. The item claim allows one run at a time, so any
 * other run of the item is an orphan. Selection is by run id and by the `omf.work` label: run ids are only unique to the
 * second, so a container counts only when its run is under `<item>/runs/` and its label is this item. Round images carry no
 * label and are selected by run id. Only per-round SUT images (`omf-sut:`) are removed; the cached harness image is kept. Containers go first, then host directories. A resource whose name does not match the container name
 * pattern is left alone; an owned container whose name is off the full pattern is reported in `skipped`.
 * An author container of an earlier pass is removed too, except while the item's `seal.lock` is held: a running
 * `omf seal` owns its own author container, and the lock is held for the whole call.
 */
export async function sweepOrphans(input: SweepInput): Promise<SweepResult> {
  const runsDir = join(input.itemDir, "runs");
  const earlier = new Set(existsSync(runsDir) ? readdirSync(runsDir) : []);
  earlier.delete(input.currentRunId);
  const result: SweepResult = { containers: 0, images: 0, staging: 0, skipped: [] };
  const sealing = isLockHeld(sealLockFile(input.itemDir));
  for (const resource of await input.runtime.listOwned({ run_id: null })) {
    if (!earlier.has(resource.run_id)) continue;
    if (resource.kind === "container") {
      if (resource.work_id !== input.workId) continue;
      const role = ROLE_OF_NAME.exec(resource.name)?.[1] as ContainerRole | undefined;
      if (role === undefined) continue;
      if (role === "author" && sealing) continue;
      // The runtime refuses a name outside the full pattern; one such resource must not stop the sweep of the others.
      try {
        assertName(resource.name);
      } catch {
        result.skipped.push(resource.name);
        continue;
      }
      await input.runtime.remove({ name: resource.name, id: resource.name, role });
      result.containers += 1;
    } else if (resource.name.startsWith("omf-sut:")) {
      await input.runtime.removeImage(resource.name as ImageId);
      result.images += 1;
    }
  }
  // `judge` holds judge staging; `implementer-stage` holds an implementer bundle, quarantine and tree. Symlinks are never followed.
  result.staging += removeStagingDirs(runsDir, earlier);
  return result;
}

/**
 * Removes every implementer container of this item (by `omf.work` label and run id), the current run's included, for the end of a line (finished, vetoed,
 * stopped at a goal or wall-time limit, or aborted): the run's own cleanup removes the tracked ones, and this catches one
 * whose removal failed. Containers only: no image, no host directory. A name off the full pattern is left alone.
 */
export async function sweepImplementerContainers(input: {
  runtime: Pick<ContainerRuntime, "listOwned" | "remove">;
  itemDir: string;
  currentRunId: string;
  /** The item's id: a run id is only unique to the second, so a container counts only when its `omf.work` label is this item. */
  workId: string;
}): Promise<number> {
  const runsDir = join(input.itemDir, "runs");
  const runs = new Set(existsSync(runsDir) ? readdirSync(runsDir) : []);
  runs.add(input.currentRunId);
  let removed = 0;
  for (const resource of await input.runtime.listOwned({ run_id: null })) {
    if (resource.kind !== "container" || !resource.name.startsWith("omf-implementer-")) continue;
    if (!runs.has(resource.run_id) || resource.work_id !== input.workId) continue;
    try {
      assertName(resource.name);
    } catch {
      continue;
    }
    await input.runtime.remove({ name: resource.name, id: resource.name, role: "implementer" });
    removed += 1;
  }
  return removed;
}

export type { FeedbackSlot, RoundState } from "./round-state.js";
