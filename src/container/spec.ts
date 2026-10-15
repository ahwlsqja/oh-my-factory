import type { JudgeConfig } from "../core/config.js";
import { type PinnedImage, isDigestPinned } from "./image-ref.js";

/** The containers M3f starts. The implementer (M3g) and the author (M3h) extend this same type. */
export const CONTAINER_ROLES = ["sut", "harness", "workcopy"] as const;
export type ContainerRole = (typeof CONTAINER_ROLES)[number];

/** The isolation stage a role is measured under. A work copy runs candidate code from the SUT base, so it is `sut` (M3f-D11). */
export const ROLE_STAGE: Readonly<Record<ContainerRole, "sut" | "harness">> = {
  sut: "sut",
  harness: "harness",
  workcopy: "sut",
};

/** An unprivileged user that owns nothing on the host; the golden facts pin this value. */
export const SANDBOX_USER = "65532:65532";
/** Containers idle until `docker exec` gives them work. The base image must ship `sleep` (a stated limit). */
export const IDLE_ENTRYPOINT = "sleep";
export const IDLE_ARGS: readonly string[] = ["2147483647"];

/** A local, immutable image id (`sha256:` and 64 hex), as `docker image inspect` reports it. */
export type ImageId = string & { readonly __imageId: true };

export type ContainerSpecErrorCode =
  | "invalid_name"
  | "invalid_label"
  | "invalid_context"
  | "invalid_image"
  | "invalid_tmpfs"
  | "invalid_limits"
  | "invalid_exec"
  | "invalid_build";

/** A bad spec or argument. The message is the code only: no input text can leak through it. */
export class ContainerSpecError extends Error {
  constructor(readonly code: ContainerSpecErrorCode) {
    super(code);
    this.name = "ContainerSpecError";
  }
}

export interface OwnedLabels {
  work_id: string;
  run_id: string;
  /** 0 is only for the doctor's throwaway probe; a judged round is >= 1. */
  round: number;
  role: ContainerRole;
}

export interface TmpfsSpec {
  destination: "/tmp" | "/scratch" | "/state" | "/work";
  size_mb: number;
  exec: boolean;
  /** Owned by the sandbox user (uid and gid 65532); otherwise root-owned. */
  owned: boolean;
}

/**
 * Everything `docker create` may be told. There is deliberately no field for a mount, a volume, a privilege, a
 * capability, a device, a PID or IPC share, a network, a published port or an environment value: the argv builder
 * cannot emit what this type cannot express (M3f-D2).
 */
export interface ContainerSpec {
  name: string;
  image: PinnedImage | ImageId;
  labels: OwnedLabels;
  tmpfs: readonly TmpfsSpec[];
  limits: { memory_mb: number; cpus: number; pids: number };
}

// The run id pattern of the W events and the work id pattern of the W verbs, repeated here so the container layer imports
// nothing from `work/`; tests/container/argv.test.ts pins the run id copy to `RUN_ID_PATTERN` in `src/work/w-events.ts`.
export const RUN_ID_RE = /^r-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{4}$/;
export const WORK_ID_RE = /^w-[0-9a-f]{12}$/;
const NAME_RE = /^omf-(sut|harness|workcopy)-r-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{4}-[0-9]+-[0-9]+$/;
const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;
const CONTEXT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** A reference that is safe to hand to `docker image inspect`: no leading "-", no whitespace. */
const IMAGE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,254}$/;
const CPUS_RE = /^[0-9]+(\.[0-9]{1,2})?$/;
const TMPFS_DESTINATIONS: readonly string[] = ["/tmp", "/scratch", "/state", "/work"];

export function isImageId(value: string): value is ImageId {
  return IMAGE_ID_RE.test(value);
}

export function assertImageRef(ref: string): void {
  if (!IMAGE_REF_RE.test(ref)) throw new ContainerSpecError("invalid_image");
}

export function assertLabels(labels: OwnedLabels): void {
  const ok =
    WORK_ID_RE.test(labels.work_id) &&
    RUN_ID_RE.test(labels.run_id) &&
    (CONTAINER_ROLES as readonly string[]).includes(labels.role) &&
    Number.isInteger(labels.round) &&
    labels.round >= 0 &&
    labels.round <= 9999;
  if (!ok) throw new ContainerSpecError("invalid_label");
}

/** `omf-<role>-<run_id>-<round>-<serial>`; the name carries the role and run so a sweep and a reader can tell what it is. */
export function containerName(labels: OwnedLabels, serial: number): string {
  assertLabels(labels);
  if (!Number.isSafeInteger(serial) || serial < 0) throw new ContainerSpecError("invalid_name");
  return `omf-${labels.role}-${labels.run_id}-${labels.round}-${serial}`;
}

/** The name must match the pattern and, when labels are given, be the name of exactly that role, run and round. */
export function assertName(name: string, labels?: OwnedLabels): void {
  if (!NAME_RE.test(name)) throw new ContainerSpecError("invalid_name");
  if (labels !== undefined && !name.startsWith(`omf-${labels.role}-${labels.run_id}-${labels.round}-`)) {
    throw new ContainerSpecError("invalid_name");
  }
}

export function assertContext(context: string | null): void {
  if (context !== null && !CONTEXT_RE.test(context)) throw new ContainerSpecError("invalid_context");
}

export function assertSpec(spec: ContainerSpec): void {
  assertLabels(spec.labels);
  assertName(spec.name, spec.labels);
  if (!isDigestPinned(spec.image) && !IMAGE_ID_RE.test(spec.image)) throw new ContainerSpecError("invalid_image");
  const seen = new Set<string>();
  for (const tmpfs of spec.tmpfs) {
    const ok =
      TMPFS_DESTINATIONS.includes(tmpfs.destination) &&
      !seen.has(tmpfs.destination) &&
      Number.isInteger(tmpfs.size_mb) &&
      tmpfs.size_mb >= 1 &&
      tmpfs.size_mb <= 4096;
    if (!ok) throw new ContainerSpecError("invalid_tmpfs");
    seen.add(tmpfs.destination);
  }
  const { memory_mb: memory, cpus, pids } = spec.limits;
  const limitsOk =
    Number.isInteger(memory) &&
    memory >= 16 &&
    memory <= 65536 &&
    Number.isInteger(pids) &&
    pids >= 1 &&
    pids <= 32768 &&
    CPUS_RE.test(String(cpus)) &&
    cpus > 0 &&
    cpus <= 64;
  if (!limitsOk) throw new ContainerSpecError("invalid_limits");
}

/**
 * The scratch filesystems of a role, all tmpfs and all owned by the sandbox user. Nothing persists past the container,
 * and no role has a bind mount: the harness receives its scenarios over stdin and a work copy its tree through `tar -x`
 * on stdin (M3f-D22). Only `/work` is executable (a work copy runs the declared gates there).
 */
export function roleTmpfs(
  role: ContainerRole,
  sizes: Pick<JudgeConfig, "tmp_tmpfs_mb" | "scratch_tmpfs_mb" | "work_tmpfs_mb" | "state_tmpfs_mb">,
): TmpfsSpec[] {
  const tmp: TmpfsSpec = { destination: "/tmp", size_mb: sizes.tmp_tmpfs_mb, exec: false, owned: true };
  switch (role) {
    case "sut":
      return [tmp, { destination: "/scratch", size_mb: sizes.scratch_tmpfs_mb, exec: false, owned: true }];
    case "harness":
      return [tmp, { destination: "/state", size_mb: sizes.state_tmpfs_mb, exec: false, owned: true }];
    case "workcopy":
      return [tmp, { destination: "/work", size_mb: sizes.work_tmpfs_mb, exec: true, owned: true }];
  }
}
