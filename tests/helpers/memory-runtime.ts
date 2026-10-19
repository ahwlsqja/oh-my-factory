import { imageIdFor } from "./image-id.js";
import type { ProcessResult } from "../../src/adapters/process-group.js";
import type {
  ContainerHandle,
  ContainerRuntime,
  ExecSpec,
  ImageInfo,
  OwnedResource,
} from "../../src/container/runtime.js";
import type { ContainerSpec, ImageId } from "../../src/container/spec.js";

export const EXIT_0: ProcessResult = { kind: "exited", status: 0, signal: null, stdout: "", stderr: "" };
export const exit = (status: number): ProcessResult => ({
  kind: "exited",
  status,
  signal: null,
  stdout: "",
  stderr: "",
});

export interface RecordedExec {
  name: string;
  argv: readonly string[];
  stdin: string | Buffer | undefined;
  workdir: string | undefined;
}

/**
 * A `ContainerRuntime` that keeps everything in memory and records what was asked of it. It has no inspect JSON and no image
 * store, so it serves the tests of lifecycle and work-copy behaviour; measurement is tested against the fake docker (Task 4).
 * `calls` lists the daemon-changing requests in order: "create N", "start N", "remove N", "removeAllSync N,M", "rmi ID".
 */
/** A labelled round image is listed with the id the daemon reported when it was inspected; the double derives one from the name. */
const withImageId = (resource: OwnedResource): OwnedResource =>
  resource.kind === "image" && resource.work_id !== "" && resource.image_id === undefined
    ? { ...resource, image_id: imageIdFor(resource.name) }
    : resource;

export class MemoryRuntime implements ContainerRuntime {
  readonly context = "colima-omf-m3f";
  readonly specs: ContainerSpec[] = [];
  readonly execs: RecordedExec[] = [];
  readonly calls: string[] = [];
  readonly live = new Map<string, ContainerHandle>();
  /** What `listOwned` reports; removals delete from it. */
  owned: OwnedResource[] = [];
  failCreate = false;
  failImageRemoval = false;
  /** The daemon cannot answer an inspect: the state of a container is then unknown. */
  failInspect = false;
  onExec: (name: string, spec: ExecSpec) => ProcessResult | Promise<ProcessResult> = () => EXIT_0;

  async endpoint(): Promise<{ kind: "unix"; local: true }> {
    return { kind: "unix", local: true };
  }

  async info(): Promise<{ ok: true; server_version: string }> {
    return { ok: true, server_version: "memory" };
  }

  async ensureImage(): Promise<ImageInfo> {
    throw new Error("MemoryRuntime.ensureImage is not used");
  }

  async imageInfo(): Promise<ImageInfo> {
    throw new Error("MemoryRuntime.imageInfo is not used");
  }

  async build(): Promise<ImageInfo> {
    throw new Error("MemoryRuntime.build is not used");
  }

  async create(spec: ContainerSpec): Promise<ContainerHandle> {
    if (this.failCreate) throw new Error("create failed");
    this.specs.push(spec);
    this.calls.push(`create ${spec.name}`);
    const handle: ContainerHandle = { name: spec.name, id: spec.name, role: spec.labels.role };
    this.live.set(spec.name, handle);
    return handle;
  }

  /** Containers a test stopped by hand (a lifetime that ran out): still known to the daemon, no longer running. */
  readonly stopped = new Set<string>();

  async inspect(handle: ContainerHandle): Promise<unknown> {
    if (this.failInspect) throw new Error("inspect failed");
    return { State: { Running: this.live.has(handle.name) && !this.stopped.has(handle.name) } };
  }

  async start(handle: ContainerHandle): Promise<void> {
    this.calls.push(`start ${handle.name}`);
  }

  async exec(handle: ContainerHandle, spec: ExecSpec): Promise<ProcessResult> {
    this.execs.push({ name: handle.name, argv: spec.argv, stdin: spec.stdin, workdir: spec.workdir });
    return this.onExec(handle.name, spec);
  }

  async remove(handle: ContainerHandle): Promise<void> {
    this.calls.push(`remove ${handle.name}`);
    this.forget([handle.name]);
  }

  async removeImage(id: ImageId): Promise<void> {
    if (this.failImageRemoval) throw new Error("image removal failed");
    this.calls.push(`rmi ${id}`);
    this.owned = this.owned.filter((resource) => !(resource.kind === "image" && withImageId(resource).image_id === id));
  }

  async listOwned(filter: { run_id: string | null }): Promise<OwnedResource[]> {
    return this.owned
      .filter((resource) => filter.run_id === null || resource.run_id === filter.run_id)
      .map(withImageId);
  }

  removeAllSync(names: readonly string[]): void {
    this.calls.push(`removeAllSync ${names.join(",")}`);
    this.forget(names);
  }

  private forget(names: readonly string[]): void {
    for (const name of names) this.live.delete(name);
    this.owned = this.owned.filter((resource) => !(resource.kind === "container" && names.includes(resource.name)));
  }
}
