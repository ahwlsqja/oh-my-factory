import { isAbsolute } from "node:path";
import { agentExecEnvRefused } from "../core/env-deny.js";
import { isDigestPinned } from "./image-ref.js";
import type { PinnedImage } from "./image-ref.js";
import {
  AUTHOR_FIXED_ENV,
  type ContainerRole,
  type ContainerSpec,
  ContainerSpecError,
  IDLE_ENTRYPOINT,
  IMPLEMENTER_FIXED_ENV,
  type ImageId,
  type OwnedLabels,
  ROLE_NETWORK,
  SANDBOX_USER,
  SECRET_ENV_NAMES,
  type SecretEnvName,
  type TmpfsSpec,
  assertContext,
  assertImageRef,
  assertLabels,
  assertName,
  assertSpec,
  isImageId,
} from "./spec.js";

/**
 * The only place a `docker` command line for a container is assembled (spec §7). Every builder returns the argv
 * AFTER the program name and starts with `--context <ctx>` when a context is given. Names, labels, contexts and tags are
 * validated against closed patterns first, so a bad input throws `ContainerSpecError` before any argv exists. Candidate
 * and scenario data enters only as `docker exec` elements after the container name, never in a flag position.
 */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WORKDIR_RE = /^\/[A-Za-z0-9_./-]*$/;
const BUILD_TAG_RE = /^omf-(sut|harness):[A-Za-z0-9_.-]{1,128}$/;
const CONTEXT_HASH_RE = /^[0-9a-f]{64}$/;

function contextArgs(context: string | null): string[] {
  assertContext(context);
  return context === null ? [] : ["--context", context];
}

function labelArgs(labels: OwnedLabels): string[] {
  assertLabels(labels);
  const pairs: Array<[string, string]> = [
    ["omf.owner", "omf"],
    ["omf.work", labels.work_id],
    ["omf.run", labels.run_id],
    ["omf.round", String(labels.round)],
    ["omf.role", labels.role],
  ];
  return pairs.flatMap(([key, value]) => ["--label", `${key}=${value}`]);
}

/** `dest:rw,size=<n>m,nosuid,nodev[,exec][,uid=65532,gid=65532]`. Docker's tmpfs default is noexec, so `exec` is opt-in. */
function tmpfsOption(tmpfs: TmpfsSpec): string {
  const owner = SANDBOX_USER.replace(":", ",gid=");
  return `${tmpfs.destination}:rw,size=${tmpfs.size_mb}m,nosuid,nodev${tmpfs.exec ? ",exec" : ""}${tmpfs.owned ? `,uid=${owner}` : ""}`;
}

/** The create-time environment a role carries besides `LC_ALL`: constants of spec.ts, never caller input. */
function fixedEnvOf(role: ContainerRole): readonly (readonly [name: string, value: string])[] {
  if (role === "implementer") return IMPLEMENTER_FIXED_ENV;
  if (role === "author") return AUTHOR_FIXED_ENV;
  return [];
}

/**
 * Every role gets the same hardening flags. The two agent roles differ in exactly two values: they are the only roles on a
 * network (`bridge`, so the vendor CLI can reach its API; spec §7 L2) and each carries its own fixed environment.
 */
export function createArgv(spec: ContainerSpec, context: string | null): string[] {
  assertSpec(spec);
  const { limits } = spec;
  return [
    ...contextArgs(context),
    "create",
    "--name",
    spec.name,
    "--pull",
    "never",
    ...labelArgs(spec.labels),
    "--network",
    ROLE_NETWORK[spec.labels.role],
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--user",
    SANDBOX_USER,
    "--pids-limit",
    String(limits.pids),
    "--memory",
    `${limits.memory_mb}m`,
    "--cpus",
    String(limits.cpus),
    "--stop-timeout",
    "1",
    "--env",
    "LC_ALL=C",
    ...fixedEnvOf(spec.labels.role).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
    ...spec.tmpfs.flatMap((tmpfs) => ["--tmpfs", tmpfsOption(tmpfs)]),
    "--entrypoint",
    IDLE_ENTRYPOINT,
    spec.image,
    String(spec.lifetime_s),
  ];
}

export function startArgv(name: string, context: string | null): string[] {
  assertName(name);
  return [...contextArgs(context), "start", name];
}

/** `container inspect`, so an image of the same name can never answer. */
export function inspectArgv(name: string, context: string | null): string[] {
  assertName(name);
  return [...contextArgs(context), "container", "inspect", name];
}

export interface ExecArgvSpec {
  argv: readonly string[];
  workdir?: string;
  env?: Readonly<Record<string, string>>;
  /** Emitted as `--env <NAME>` with no value; the docker client takes the value from its own environment. */
  secret?: SecretEnvName;
  /**
   * The role of the container. For an agent role (implementer, author) `env` may not set HOME, a vendor variable
   * (CODEX_*, OPENAI_*, ANTHROPIC_*, CLAUDE_CONFIG_DIR) or a credential-shaped name: those would move the CLI's home or
   * endpoint, or hand it a second key. Nothing sets an env on an agent exec today; this keeps it that way.
   */
  role?: ContainerRole;
  /** True adds `-i`; the bytes themselves travel on the process stdin, never in argv. */
  stdin: boolean;
}

/** After the container name Docker parses no more flags, so `argv` elements such as `--privileged` stay plain command words. */
export function execArgv(name: string, exec: ExecArgvSpec, context: string | null): string[] {
  assertName(name);
  if (exec.argv.length === 0 || exec.argv.some((element) => element.includes("\0"))) {
    throw new ContainerSpecError("invalid_exec");
  }
  const flags: string[] = [];
  if (exec.stdin) flags.push("-i");
  if (exec.workdir !== undefined) {
    if (!WORKDIR_RE.test(exec.workdir)) throw new ContainerSpecError("invalid_exec");
    flags.push("--workdir", exec.workdir);
  }
  for (const [key, value] of Object.entries(exec.env ?? {})) {
    // A secret in `env` would put its value in argv; the only way to give an exec a secret is `secret`, by name.
    if (!ENV_NAME_RE.test(key) || (SECRET_ENV_NAMES as readonly string[]).includes(key) || value.includes("\0")) {
      throw new ContainerSpecError("invalid_exec");
    }
    if ((exec.role === "implementer" || exec.role === "author") && agentExecEnvRefused(key)) {
      throw new ContainerSpecError("invalid_exec");
    }
    flags.push("--env", `${key}=${value}`);
  }
  if (exec.secret !== undefined) {
    if (!(SECRET_ENV_NAMES as readonly string[]).includes(exec.secret)) throw new ContainerSpecError("invalid_exec");
    flags.push("--env", exec.secret);
  }
  return [...contextArgs(context), "exec", ...flags, name, ...exec.argv];
}

export interface BuildArgvSpec {
  contextDir: string;
  tag: string;
  labels: OwnedLabels;
  /** Full hash of the harness build context; lets a cached image be reused only when the hash matches. */
  contextHash?: string;
}

/** No network, no pull, no cache: the build is self-contained and repeatable. The context is a host directory OMF just wrote. */
export function buildArgv(build: BuildArgvSpec, context: string | null): string[] {
  const ok =
    BUILD_TAG_RE.test(build.tag) &&
    isAbsolute(build.contextDir) &&
    !build.contextDir.includes("\0") &&
    (build.contextHash === undefined || CONTEXT_HASH_RE.test(build.contextHash));
  if (!ok) throw new ContainerSpecError("invalid_build");
  return [
    ...contextArgs(context),
    "build",
    "--network",
    "none",
    "--pull=false",
    "--no-cache",
    ...labelArgs(build.labels),
    ...(build.contextHash === undefined ? [] : ["--label", `omf.context=${build.contextHash}`]),
    "--tag",
    build.tag,
    build.contextDir,
  ];
}

/** Idempotent removal that also drops anonymous volumes, so a base image that declares VOLUME leaves none behind. */
export function removeArgv(names: readonly string[], context: string | null): string[] {
  if (names.length === 0) throw new ContainerSpecError("invalid_name");
  for (const name of names) assertName(name);
  return [...contextArgs(context), "rm", "--force", "--volumes", ...names];
}

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const OMF_IMAGE_RE = /^(omf-sut|omf-harness):[A-Za-z0-9_.-]{1,128}$/;

/** `ps --all` for containers, `image ls` for images; both only what OMF labelled. A run id narrows containers by label. */
export function listOwnedArgv(kind: "container" | "image", runId: string | null, context: string | null): string[] {
  if (runId !== null && !RUN_ID_RE.test(runId)) throw new ContainerSpecError("invalid_name");
  const owner = ["--filter", "label=omf.owner=omf"];
  if (kind === "image") {
    return [...contextArgs(context), "image", "ls", ...owner, "--format", "{{.Repository}}:{{.Tag}}"];
  }
  const run = runId === null ? [] : ["--filter", `label=omf.run=${runId}`];
  const format = '{{.Names}}\t{{.Label "omf.run"}}\t{{.Label "omf.work"}}';
  return [...contextArgs(context), "ps", "--all", ...owner, ...run, "--format", format];
}

/** Removes one OMF round image or harness image by tag, or any local image by id. Never a base image by tag. */
export function removeImageArgv(id: ImageId, context: string | null): string[] {
  if (!OMF_IMAGE_RE.test(id) && !isImageId(id)) throw new ContainerSpecError("invalid_image");
  return [...contextArgs(context), "image", "rm", "--force", id];
}

export function infoArgv(context: string | null): string[] {
  return [...contextArgs(context), "info", "--format", "{{.ServerVersion}}"];
}

export function imageInspectArgv(ref: string, context: string | null): string[] {
  assertImageRef(ref);
  return [...contextArgs(context), "image", "inspect", ref];
}

/** Only a digest reference can be pulled: the daemon fetches an immutable name. */
export function pullArgv(ref: PinnedImage, context: string | null): string[] {
  if (!isDigestPinned(ref)) throw new ContainerSpecError("invalid_image");
  return [...contextArgs(context), "pull", "--quiet", ref];
}

/** Reads a named docker context. The context is the object here, so there is no `--context` prefix. */
export function contextInspectArgv(context: string): string[] {
  assertContext(context);
  return ["context", "inspect", context];
}
