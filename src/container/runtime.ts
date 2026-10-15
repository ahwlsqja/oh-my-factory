import type { ProcessResult } from "../adapters/process-group.js";
import type { PinnedImage } from "./image-ref.js";
import type { ContainerRole, ContainerSpec, ImageId, OwnedLabels, SecretEnvName } from "./spec.js";

export interface EndpointInfo {
  kind: "unix" | "tcp" | "ssh" | "other";
  /** Only a local `unix://` socket is local: untrusted code is never built or run elsewhere (M3f-D3). */
  local: boolean;
}

export interface ImageInfo {
  id: ImageId;
  /** Names of the image's own `ENV`, never the values. */
  env_names: string[];
  user: string;
  /** `Config.Volumes` keys. A base image that declares `VOLUME` would give every container an anonymous volume, so it is refused. */
  volumes: string[];
}

export interface ContainerHandle {
  readonly name: string;
  readonly id: string;
  readonly role: ContainerRole;
}

/** A container or image carrying `omf.owner=omf`. An image's run id is read from its tag (`omf-sut:<run_id>-<round>`); a cached harness image belongs to no run and reports "". */
export interface OwnedResource {
  kind: "container" | "image";
  name: string;
  run_id: string;
}

/**
 * The container layer's view of a secret. The value is reachable only through `reveal()`, which the docker adapter
 * calls once, for the one child process that needs it; the handle itself prints as a mask, so a log line, a thrown
 * message or a serialized spec cannot carry the value.
 */
export interface SecretHandle {
  readonly name: SecretEnvName;
  reveal(): string;
}

export interface ExecSpec {
  argv: readonly string[];
  stdin?: string | Buffer;
  workdir?: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxOutputBytes: number;
}

export type RuntimeErrorCode =
  | "context_not_configured"
  | "endpoint_not_local"
  | "image_declares_volume"
  | "image_missing"
  | "docker_failed"
  | "output_malformed";

/** A runtime refusal or failure. The message is the code only; `detail` holds a capped docker failure text for a reader who needs it. */
export class RuntimeError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    readonly detail: string | null = null,
  ) {
    super(code);
    this.name = "RuntimeError";
  }
}

/**
 * The only way OMF touches a container engine. The adapter (docker-cli.ts) builds every command from the reviewed argv
 * module and refuses to build, pull, create, start or exec unless the configured context is a local unix socket.
 */
export interface ContainerRuntime {
  readonly context: string | null;
  /** Memoized `docker context inspect`. */
  endpoint(): Promise<EndpointInfo>;
  /** `failure` is the exact `docker info` stderr text, capped. */
  info(): Promise<{ ok: true; server_version: string } | { ok: false; failure: string }>;
  /** Local inspect first; `docker pull <digest reference>` only when the image is absent. Refuses an image that declares a volume. */
  ensureImage(ref: PinnedImage): Promise<ImageInfo>;
  imageInfo(idOrRef: string): Promise<ImageInfo>;
  build(spec: {
    contextDir: string;
    tag: string;
    labels: OwnedLabels;
    contextHash?: string;
    timeoutMs: number;
  }): Promise<ImageInfo>;
  create(spec: ContainerSpec): Promise<ContainerHandle>;
  /** The parsed `docker inspect` JSON, handed to `containerFactsFromInspect`. */
  inspect(handle: ContainerHandle): Promise<unknown>;
  start(handle: ContainerHandle): Promise<void>;
  exec(handle: ContainerHandle, spec: ExecSpec): Promise<ProcessResult>;
  /** Idempotent: removing a container that is gone succeeds. */
  remove(handle: ContainerHandle): Promise<void>;
  /** Everything OMF-labelled, or only one run's containers and round images. */
  listOwned(filter: { run_id: string | null }): Promise<OwnedResource[]>;
  /** Idempotent: removing an image that is gone succeeds. */
  removeImage(id: ImageId): Promise<void>;
  /** For a signal handler: synchronous, best effort, by name. */
  removeAllSync(names: readonly string[]): void;
}
