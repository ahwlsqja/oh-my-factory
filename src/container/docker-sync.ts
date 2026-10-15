import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import type { ProcessResult } from "../adapters/process-group.js";
import {
  contextInspectArgv,
  createArgv,
  execArgv,
  imageInspectArgv,
  infoArgv,
  inspectArgv,
  removeArgv,
  startArgv,
} from "./argv.js";
import { dockerEnv, endpointKind, resolveDockerConfig } from "./docker-cli.js";
import type { ContainerHandle, ExecSpec, ImageInfo } from "./runtime.js";
import type { ContainerSpec, ImageId } from "./spec.js";

/**
 * The synchronous twin of the async runtime, for `omf doctor` only (its report is synchronous). Same argv builders, same
 * docker environment (PATH and an explicit DOCKER_CONFIG, nothing else). No pull, no build, no stdin.
 */
export interface ContainerRuntimeSync {
  readonly context: string | null;
  infoSync(): { ok: true; server_version: string } | { ok: false; failure: string };
  endpointSync(): { kind: "unix" | "tcp" | "ssh" | "other"; local: boolean };
  /** `null` when the image is not in the local store. Never pulls. */
  imageInfoSync(ref: string): ImageInfo | null;
  createSync(spec: ContainerSpec): ContainerHandle;
  inspectSync(handle: ContainerHandle): unknown;
  startSync(handle: ContainerHandle): void;
  execSync(handle: ContainerHandle, spec: ExecSpec): ProcessResult;
  removeSync(handle: ContainerHandle): void;
}

export type SyncRun = (argv: readonly string[]) => { status: number | null; stdout: string; stderr: string };

export class SyncRuntimeError extends Error {
  constructor(readonly code: "context_not_configured" | "endpoint_not_local" | "docker_failed" | "bad_output") {
    super(code);
    this.name = "SyncRuntimeError";
  }
}

export interface DockerSyncOptions {
  /** `docker --context <name>`. `null` is refused: the client's current context is never used. */
  context: string | null;
  run?: SyncRun;
  dockerConfig?: string;
  /** The CALLER's environment, read only for PATH and `resolveDockerConfig`. */
  env?: NodeJS.ProcessEnv;
}

const MAX_FAILURE_CHARS = 2000;
const CALL_TIMEOUT_MS = 20_000;
const CONTAINER_ID = /^[0-9a-f]{12,64}$/;

function spawnDocker(env: NodeJS.ProcessEnv): SyncRun {
  return (argv) => {
    const result = spawnSync("docker", [...argv], {
      env,
      cwd: tmpdir(),
      encoding: "utf8",
      timeout: CALL_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    if (result.error !== undefined) return { status: null, stdout: "", stderr: result.error.message };
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

export function createDockerRuntimeSync(options: DockerSyncOptions): ContainerRuntimeSync {
  const callerEnv = options.env ?? process.env;
  const run = options.run ?? spawnDocker(dockerEnv(callerEnv, options.dockerConfig ?? resolveDockerConfig(callerEnv)));
  const { context } = options;
  const need = (): string => {
    if (context === null) throw new SyncRuntimeError("context_not_configured");
    return context;
  };
  const succeed = (argv: readonly string[]): string => {
    const result = run(argv);
    if (result.status !== 0) throw new SyncRuntimeError("docker_failed");
    return result.stdout;
  };
  let endpoint: ReturnType<ContainerRuntimeSync["endpointSync"]> | null = null;
  const lookupEndpoint = (name: string): { kind: "unix" | "tcp" | "ssh" | "other"; local: boolean } => {
    const text = succeed(contextInspectArgv(name));
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new SyncRuntimeError("bad_output");
    }
    const first: unknown = Array.isArray(doc) ? doc[0] : undefined;
    const host = (first as { Endpoints?: { docker?: { Host?: unknown } } } | null | undefined)?.Endpoints?.docker?.Host;
    if (typeof host !== "string") throw new SyncRuntimeError("bad_output");
    const kind = endpointKind(host);
    return { kind, local: kind === "unix" };
  };
  /** Same rule as the async runtime: nothing is created, started or run on an endpoint that is not a local unix socket. */
  const requireLocal = (): string => {
    const name = need();
    endpoint ??= lookupEndpoint(name);
    if (!endpoint.local) throw new SyncRuntimeError("endpoint_not_local");
    return name;
  };

  return {
    context,
    infoSync() {
      const result = run(infoArgv(need()));
      if (result.status === 0 && result.stdout.trim() !== "") return { ok: true, server_version: result.stdout.trim() };
      const text =
        result.stderr.trim() || result.stdout.trim() || `docker info exited with status ${result.status ?? "none"}`;
      return { ok: false, failure: text.slice(0, MAX_FAILURE_CHARS) };
    },
    endpointSync() {
      endpoint ??= lookupEndpoint(need());
      return endpoint;
    },
    imageInfoSync(ref) {
      const result = run(imageInspectArgv(ref, need()));
      if (result.status !== 0) return null;
      let doc: unknown;
      try {
        doc = JSON.parse(result.stdout);
      } catch {
        throw new SyncRuntimeError("bad_output");
      }
      const entry = Array.isArray(doc) && doc.length === 1 ? (doc[0] as Record<string, unknown>) : null;
      const id = entry?.Id;
      const config = entry?.Config;
      if (typeof id !== "string" || typeof config !== "object" || config === null)
        throw new SyncRuntimeError("bad_output");
      const { Env, User, Volumes } = config as { Env?: unknown; User?: unknown; Volumes?: unknown };
      const env = Array.isArray(Env) ? Env.filter((value): value is string => typeof value === "string") : [];
      return {
        id: id as ImageId,
        env_names: [...new Set(env.map((text) => text.split("=")[0] ?? ""))].sort(),
        user: typeof User === "string" ? User : "",
        volumes: Volumes !== null && typeof Volumes === "object" ? Object.keys(Volumes) : [],
      };
    },
    createSync(spec) {
      const id = succeed(createArgv(spec, requireLocal())).trim();
      if (!CONTAINER_ID.test(id)) throw new SyncRuntimeError("bad_output");
      return { name: spec.name, id, role: spec.labels.role };
    },
    inspectSync(handle) {
      const text = succeed(inspectArgv(handle.name, need()));
      try {
        return JSON.parse(text);
      } catch {
        throw new SyncRuntimeError("bad_output");
      }
    },
    startSync(handle) {
      succeed(startArgv(handle.name, requireLocal()));
    },
    execSync(handle, spec) {
      const result = run(
        execArgv(
          handle.name,
          {
            argv: spec.argv,
            stdin: false,
            ...(spec.workdir !== undefined ? { workdir: spec.workdir } : {}),
            ...(spec.env !== undefined ? { env: spec.env } : {}),
          },
          requireLocal(),
        ),
      );
      if (result.status === null) return { kind: "error", code: null, message: result.stderr.slice(0, 200) };
      return { kind: "exited", status: result.status, signal: null, stdout: result.stdout, stderr: result.stderr };
    },
    removeSync(handle) {
      succeed(removeArgv([handle.name], need()));
    },
  };
}
