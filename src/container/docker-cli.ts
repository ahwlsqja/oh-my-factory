import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { type ProcessResult, runProcessGroup } from "../adapters/process-group.js";
import {
  buildArgv,
  contextInspectArgv,
  createArgv,
  execArgv,
  imageInspectArgv,
  infoArgv,
  inspectArgv,
  listOwnedArgv,
  pullArgv,
  removeArgv,
  removeImageArgv,
  startArgv,
} from "./argv.js";
import type { PinnedImage } from "./image-ref.js";
import {
  type ContainerHandle,
  type ContainerRuntime,
  type EndpointInfo,
  type ImageInfo,
  type OwnedResource,
  RuntimeError,
  type SecretHandle,
} from "./runtime.js";
import { isMeasured } from "./measured-handles.js";
import { ContainerSpecError, ROLE_SECRET, isImageId } from "./spec.js";

export type DockerRunner = (
  argv: readonly string[],
  options: {
    stdin?: string | Buffer;
    timeoutMs: number;
    maxOutputBytes: number;
    tailOnly?: boolean;
    /** Added to the client's environment for this one child only (a secret exec); the base environment stays PATH and DOCKER_CONFIG. */
    env?: Readonly<Record<string, string>>;
  },
) => Promise<ProcessResult>;

export interface DockerRuntimeOptions {
  /** The docker context to use; null refuses every call (`context_not_configured`). The client's current context is never used. */
  context: string | null;
  /** Default: `docker` through the process-group runner with `cwd` set to the OS temp dir and the env of `dockerEnv`. */
  run?: DockerRunner;
  runSync?: (argv: readonly string[]) => { status: number | null; stdout: string; stderr: string };
  /** An explicit DOCKER_CONFIG; default `resolveDockerConfig(env)`. */
  dockerConfig?: string;
  /** The CALLER's environment, read only by `resolveDockerConfig`; the client sees PATH and DOCKER_CONFIG only. */
  env?: NodeJS.ProcessEnv;
}

/** A path that cannot exist, used when neither DOCKER_CONFIG nor an absolute HOME is known: the client then finds no context and fails closed. */
const UNSET_HOME_DOCKER_CONFIG = "/nonexistent/omf-docker-config";
const QUICK_MS = 15_000;
const META_MS = 60_000;
const PULL_MS = 600_000;
const META_BYTES = 4 * 1024 * 1024;
const FAILURE_CAP = 2000;

/**
 * The caller's DOCKER_CONFIG, else `<caller HOME>/.docker`. It is never left unset: with HOME unset the docker client falls
 * back to the passwd home and would read the real `~/.docker`. A relative value is not trusted either.
 */
export function resolveDockerConfig(callerEnv: NodeJS.ProcessEnv): string {
  const explicit = callerEnv.DOCKER_CONFIG;
  if (explicit !== undefined && explicit !== "") return isAbsolute(explicit) ? explicit : UNSET_HOME_DOCKER_CONFIG;
  const home = callerEnv.HOME;
  return home !== undefined && isAbsolute(home) ? join(home, ".docker") : UNSET_HOME_DOCKER_CONFIG;
}

/** The environment the docker client sees: PATH and DOCKER_CONFIG, nothing else (no HOME, no OMF_*, no credential). */
export function dockerEnv(base: NodeJS.ProcessEnv, dockerConfig: string): NodeJS.ProcessEnv {
  return { PATH: base.PATH ?? "", DOCKER_CONFIG: dockerConfig };
}

function failureText(result: ProcessResult): string {
  switch (result.kind) {
    case "exited":
      return (result.stderr.trim() || `exited with status ${result.status}`).slice(0, FAILURE_CAP);
    case "timeout":
      return "timed out";
    case "output_limit":
      return "output limit exceeded";
    case "error":
      return result.message.slice(0, FAILURE_CAP);
  }
}

/** The value for one exec. A value the docker client could not carry faithfully is refused before any process starts. */
function secretValue(secret: SecretHandle): string {
  const value = secret.reveal();
  if (value === "" || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new ContainerSpecError("invalid_exec");
  }
  return value;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new RuntimeError("output_malformed");
  }
}

/** Reads `path` out of parsed JSON; anything missing or of another shape is `undefined`. */
function dig(value: unknown, ...path: string[]): unknown {
  let at: unknown = value;
  for (const key of path) {
    if (typeof at !== "object" || at === null || Array.isArray(at) || !Object.hasOwn(at, key)) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

/** The first element of the JSON array `docker ... inspect` prints. */
function firstDocument(text: string): object {
  const parsed = parseJson(text);
  const first = Array.isArray(parsed) ? parsed[0] : undefined;
  if (typeof first !== "object" || first === null) throw new RuntimeError("output_malformed");
  return first;
}

export function endpointKind(host: string): EndpointInfo["kind"] {
  if (host.startsWith("unix://")) return "unix";
  if (host.startsWith("tcp://")) return "tcp";
  if (host.startsWith("ssh://")) return "ssh";
  return "other";
}

function imageInfoOf(doc: object): ImageInfo {
  const id = dig(doc, "Id");
  const env = dig(doc, "Config", "Env") ?? [];
  const user = dig(doc, "Config", "User") ?? "";
  const volumes = dig(doc, "Config", "Volumes") ?? {};
  if (typeof id !== "string" || !isImageId(id)) throw new RuntimeError("output_malformed");
  if (!Array.isArray(env) || !env.every((entry): entry is string => typeof entry === "string")) {
    throw new RuntimeError("output_malformed");
  }
  if (typeof user !== "string") throw new RuntimeError("output_malformed");
  if (typeof volumes !== "object" || volumes === null || Array.isArray(volumes)) {
    throw new RuntimeError("output_malformed");
  }
  return {
    id,
    env_names: env.map((entry) => (entry.includes("=") ? entry.slice(0, entry.indexOf("=")) : entry)),
    user,
    volumes: Object.keys(volumes),
  };
}

/** The `ContainerRuntime` over the `docker` CLI (spec §7). The only module that starts the docker program. */
export function createDockerRuntime(options: DockerRuntimeOptions): ContainerRuntime {
  const { context } = options;
  const callerEnv = options.env ?? process.env;
  const env = dockerEnv(callerEnv, options.dockerConfig ?? resolveDockerConfig(callerEnv));
  const run: DockerRunner =
    options.run ??
    ((argv, { env: extra, ...limits }) =>
      runProcessGroup(["docker", ...argv], {
        cwd: tmpdir(),
        env: extra === undefined ? env : { ...env, ...extra },
        ...limits,
      }));
  const runSync =
    options.runSync ??
    ((argv: readonly string[]) => {
      const result = spawnSync("docker", [...argv], {
        cwd: tmpdir(),
        env,
        encoding: "utf8",
        timeout: QUICK_MS,
        killSignal: "SIGKILL",
      });
      return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    });

  function requireContext(): string {
    if (context === null) throw new RuntimeError("context_not_configured");
    return context;
  }

  /** Runs a command that must succeed and returns its stdout. */
  async function succeed(argv: string[], timeoutMs: number, tailOnly = false): Promise<string> {
    const result = await run(argv, { timeoutMs, maxOutputBytes: META_BYTES, ...(tailOnly ? { tailOnly } : {}) });
    if (result.kind !== "exited" || result.status !== 0) throw new RuntimeError("docker_failed", failureText(result));
    return result.stdout;
  }

  let endpointMemo: Promise<EndpointInfo> | null = null;
  async function lookupEndpoint(name: string): Promise<EndpointInfo> {
    const host = dig(firstDocument(await succeed(contextInspectArgv(name), META_MS)), "Endpoints", "docker", "Host");
    if (typeof host !== "string") throw new RuntimeError("output_malformed");
    const kind = endpointKind(host);
    return { kind, local: kind === "unix" };
  }
  async function endpoint(): Promise<EndpointInfo> {
    const name = requireContext();
    if (endpointMemo === null) {
      // A failure is not remembered: the next call asks again.
      endpointMemo = lookupEndpoint(name).catch((error: unknown) => {
        endpointMemo = null;
        throw error;
      });
    }
    return endpointMemo;
  }
  /** Run before anything that would put candidate-influenced bytes on a daemon or execute them. */
  async function requireLocal(): Promise<string> {
    const name = requireContext();
    if (!(await endpoint()).local) throw new RuntimeError("endpoint_not_local");
    return name;
  }

  /** The inspect document of a local image, or null when the daemon does not hold it. */
  async function localImageDoc(ref: string): Promise<object | null> {
    const argv = imageInspectArgv(ref, requireContext());
    const result = await run(argv, { timeoutMs: QUICK_MS, maxOutputBytes: META_BYTES });
    if (result.kind === "exited" && result.status === 0) return firstDocument(result.stdout);
    if (result.kind === "exited" && /No such image/i.test(result.stderr)) return null;
    throw new RuntimeError("docker_failed", failureText(result));
  }

  async function imageInfo(ref: string): Promise<ImageInfo> {
    const doc = await localImageDoc(ref);
    if (doc === null) throw new RuntimeError("image_missing");
    return imageInfoOf(doc);
  }

  return {
    context,
    endpoint,

    async info() {
      if (context === null) return { ok: false, failure: "docker context is not configured" };
      const result = await run(infoArgv(context), { timeoutMs: QUICK_MS, maxOutputBytes: META_BYTES });
      if (result.kind === "exited" && result.status === 0) return { ok: true, server_version: result.stdout.trim() };
      return { ok: false, failure: failureText(result) };
    },

    async ensureImage(ref: PinnedImage) {
      const name = await requireLocal();
      let doc = await localImageDoc(ref);
      if (doc === null) {
        await succeed(pullArgv(ref, name), PULL_MS);
        doc = await localImageDoc(ref);
        if (doc === null) throw new RuntimeError("image_missing");
      }
      const info = imageInfoOf(doc);
      if (info.volumes.length > 0) throw new RuntimeError("image_declares_volume");
      return info;
    },

    imageInfo,

    async build(spec) {
      const name = await requireLocal();
      const { timeoutMs, ...build } = spec;
      // BuildKit progress includes the candidate's own RUN output: keep a bounded tail and judge the build by its exit status.
      await succeed(buildArgv(build, name), timeoutMs, true);
      const info = await imageInfo(spec.tag);
      if (info.volumes.length > 0) throw new RuntimeError("image_declares_volume");
      return info;
    },

    async create(spec): Promise<ContainerHandle> {
      const name = await requireLocal();
      const id = (await succeed(createArgv(spec, name), META_MS)).trim();
      if (!/^[0-9a-f]{64}$/.test(id)) throw new RuntimeError("output_malformed");
      return { name: spec.name, id, role: spec.labels.role };
    },

    async inspect(handle) {
      return parseJson(await succeed(inspectArgv(handle.name, requireContext()), META_MS));
    },

    async start(handle) {
      await succeed(startArgv(handle.name, await requireLocal()), META_MS);
    },

    async exec(handle, spec) {
      const name = await requireLocal();
      const { secret } = spec;
      // Candidate code runs in every judge role, and it can read whatever its container is given: only an agent role, which is
      // measured for that, ever receives a key, and only the key of its own vendor. "Measured" is checked here: the handle must
      // be one `createMeasured` returned, so a container that was never judged golden cannot be given a key.
      if (secret !== undefined && (ROLE_SECRET[handle.role] !== secret.name || !isMeasured(handle)))
        throw new ContainerSpecError("invalid_exec");
      // The argv is built (and `spec.env` and the secret name validated) before the value is read.
      const argv = execArgv(
        handle.name,
        {
          argv: spec.argv,
          stdin: spec.stdin !== undefined,
          ...(spec.workdir === undefined ? {} : { workdir: spec.workdir }),
          ...(spec.env === undefined ? {} : { env: spec.env }),
          ...(secret === undefined ? {} : { secret: secret.name }),
          role: handle.role,
        },
        name,
      );
      return run(argv, {
        ...(spec.stdin === undefined ? {} : { stdin: spec.stdin }),
        ...(secret === undefined ? {} : { env: { [secret.name]: secretValue(secret) } }),
        timeoutMs: spec.timeoutMs,
        maxOutputBytes: spec.maxOutputBytes,
      });
    },

    async remove(handle) {
      await succeed(removeArgv([handle.name], requireContext()), META_MS);
    },

    async listOwned(filter) {
      const name = await requireLocal();
      const resources: OwnedResource[] = [];
      for (const line of (await succeed(listOwnedArgv("container", filter.run_id, name), META_MS)).split("\n")) {
        const [containerName, runId = ""] = line.trim().split("\t");
        if (containerName) resources.push({ kind: "container", name: containerName, run_id: runId });
      }
      for (const line of (await succeed(listOwnedArgv("image", null, name), META_MS)).split("\n")) {
        const tag = line.trim();
        if (!tag || tag.startsWith("<none>")) continue;
        const run = /^omf-sut:(.+)-\d+$/.exec(tag)?.[1] ?? "";
        if (filter.run_id === null || run === filter.run_id) resources.push({ kind: "image", name: tag, run_id: run });
      }
      return resources;
    },

    async removeImage(id) {
      await succeed(removeImageArgv(id, requireContext()), META_MS);
    },

    removeAllSync(names) {
      if (context === null || names.length === 0) return;
      try {
        runSync(removeArgv(names, context));
      } catch {
        // best effort inside a signal handler: nothing is left to report to
      }
    },
  };
}
