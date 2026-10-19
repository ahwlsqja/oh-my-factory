import { posix } from "node:path";
import { canonicalize, sha256Hex } from "../core/canonical-json.js";
import {
  type ContainerChecks,
  type ContainerFacts,
  type IsolationLevel,
  type IsolationStage,
  type MountFact,
  type StageMeasurement,
  type ViolationCode,
  VIOLATION_CODES,
} from "./types.js";

/**
 * The expected values for one stage. The judge containers supply them for `sut` and `harness`, the implementer container for `implementer`,\n * the author container for `author`; this module owns only the rule shape.
 */
export interface StageGolden {
  /** `source` is a realpath. A mount matches only when source and destination are equal; a different `read_only` is a violation. */
  allowed_mounts: ReadonlyArray<{ source: string; destination: string; read_only: boolean }>;
  /** Vault, the user's repo and .git, the agent config homes, the user's home, the OMF home. Exact allowed mounts are exempt. */
  forbidden_paths: readonly string[];
  /** Exact allowlist of environment variable names. */
  allowed_env_names: readonly string[];
  network: "none" | "bridge";
  require_read_only_rootfs: boolean;
  allowed_vendor_binaries: readonly string[];
  allowed_credential_paths: readonly string[];
}

export type PathRelation = "equal" | "under" | "ancestor" | "disjoint";

/** macOS volumes are case-insensitive by default, so `~/Repo` and `~/repo` are the same directory there. */
const FOLD_CASE = process.platform === "darwin";

function segmentsOf(path: string, foldCase: boolean): string[] {
  const text = foldCase ? path.toLowerCase() : path;
  return posix
    .normalize(text)
    .split("/")
    .filter((part) => part !== "" && part !== ".");
}

/**
 * How `path` relates to `other`, by whole path segment: `/a/b` is not under `/a/bc`. `under` means `path`
 * is inside `other`, `ancestor` means `path` contains `other`. Inputs are realpaths, so no symlink is resolved here.
 */
export function pathRelation(path: string, other: string, foldCase: boolean): PathRelation {
  const left = segmentsOf(path, foldCase);
  const right = segmentsOf(other, foldCase);
  let shared = 0;
  while (shared < left.length && shared < right.length && left[shared] === right[shared]) shared += 1;
  if (shared === left.length && shared === right.length) return "equal";
  if (shared === right.length) return "under";
  if (shared === left.length) return "ancestor";
  return "disjoint";
}

function sameSource(a: string, b: string): boolean {
  if (a === "" || b === "") return a === b;
  return pathRelation(a, b, FOLD_CASE) === "equal";
}

/** The hash a record stores. The clock is not part of it, so two measurements of the same container agree. */
export function measurementHash(
  stage: IsolationStage,
  mode: "container" | "host",
  facts: ContainerFacts | null,
  checks: ContainerChecks | null,
): string {
  return sha256Hex(canonicalize({ stage, mode, facts, checks }));
}

function isRoot(user: string): boolean {
  const name = user.split(":")[0] ?? "";
  return name === "" || name === "root" || /^[+-]?0+$/.test(name); // Docker parses a numeric uid with Atoi: "00" and "+0" are uid 0
}

function isDockerSocket(mount: MountFact): boolean {
  return [mount.source, mount.destination].some((path) => posix.basename(path) === "docker.sock");
}

const NO_NEW_PRIVILEGES = /^no-new-privileges(?:[:=]true)?$/;
/** Unconfined profiles, an unmasked /proc and /sys, a disabled SELinux label, and any custom seccomp profile (the golden pins none). */
const UNCONFINED =
  /^(?:(?:seccomp|apparmor|systempaths)[:=]unconfined|label[:=](?:disable|type:unconfined_t)|seccomp[:=].+)$/;
/** Private IPC and PID namespaces; "host" and "container:<id>" (joining another container's namespace) are not. */
const PRIVATE_NAMESPACE = new Set(["", "private", "shareable"]);

/**
 * Judges observed container facts against a stage golden. L2 means zero violations; anything else is L1;
 * L3 is never emitted. Pure: no clock except `at`, no file, no Docker.
 *
 * `forbidden_mount_source` is bidirectional: a bind source violates when it equals a forbidden path, sits
 * under one, or is an ANCESTOR of one, so a bind of `~` or of `~/.omf/projects/<id>` is caught even at an
 * allowed destination. The OMF home is not blanket-forbidden: the implementer worktree and the harness's
 * read-only scenario mount live under it, and they are admitted only as exact `allowed_mounts` entries.
 * The container-side `cgroupns_mode` is recorded in the facts but has no violation code in the contract.
 */
export function evaluateStage(
  stage: IsolationStage,
  observed: { facts: ContainerFacts; checks: ContainerChecks },
  golden: StageGolden,
  at: Date,
): StageMeasurement {
  const { facts, checks } = observed;
  const found = new Set<ViolationCode>();
  const flag = (code: ViolationCode, bad: boolean): void => {
    if (bad) found.add(code);
  };

  const networks = golden.network === "none" ? ["none"] : ["bridge", "default"];
  flag("docker_socket_present", checks.docker_socket_present);
  flag("privileged", facts.privileged);
  flag("cap_added", facts.cap_add.length > 0);
  flag("caps_not_dropped", !facts.cap_drop.some((cap) => cap.toUpperCase() === "ALL"));
  flag("host_network", facts.network_mode === "host");
  flag("network_not_none", facts.network_mode !== "host" && !networks.includes(facts.network_mode));
  flag("host_pid", !PRIVATE_NAMESPACE.has(facts.pid_mode));
  flag("root_user", isRoot(facts.user));
  flag("rootfs_writable", golden.require_read_only_rootfs && !facts.read_only_rootfs);
  flag(
    "unexpected_env_name",
    facts.env_names.some((name) => !golden.allowed_env_names.includes(name)),
  );
  flag(
    "vendor_binary_present",
    checks.vendor_binaries.some((name) => !golden.allowed_vendor_binaries.includes(name)),
  );
  flag(
    "credential_present",
    checks.credential_paths.some((path) => !golden.allowed_credential_paths.includes(path)),
  );
  flag("no_new_privileges_missing", !facts.security_opt.some((option) => NO_NEW_PRIVILEGES.test(option)));
  flag(
    "security_opt_unconfined",
    facts.security_opt.some((option) => UNCONFINED.test(option)),
  );
  flag("device_mapped", facts.devices.length > 0);
  flag("host_ipc", !PRIVATE_NAMESPACE.has(facts.ipc_mode));
  flag("host_uts", facts.uts_mode === "host");
  flag("userns_host", facts.userns_mode === "host");
  flag("volumes_from", facts.volumes_from.length > 0);
  flag("sysctl_set", facts.sysctls.length > 0);
  flag("runtime_unexpected", facts.runtime !== "runc");

  for (const mount of facts.mounts) {
    flag("docker_socket_mounted", isDockerSocket(mount));
    const pinned = golden.allowed_mounts.find(
      (allowed) => allowed.destination === mount.destination && sameSource(allowed.source, mount.source),
    );
    if (pinned === undefined) found.add("unexpected_mount");
    else if (pinned.read_only !== mount.read_only)
      found.add(pinned.read_only ? "mount_not_read_only" : "unexpected_mount");
    if (pinned === undefined && mount.type === "bind") {
      flag(
        "forbidden_mount_source",
        golden.forbidden_paths.some((path) => pathRelation(mount.source, path, FOLD_CASE) !== "disjoint"),
      );
    }
  }

  const violations = VIOLATION_CODES.filter((code) => found.has(code));
  const level: IsolationLevel = violations.length === 0 ? "L2" : "L1";
  return {
    stage,
    mode: "container",
    measured_at: at.toISOString(),
    facts,
    checks,
    level,
    violations,
    facts_sha256: measurementHash(stage, "container", facts, checks),
  };
}

/** A stage that ran on the host: L1 with `no_container`. It exists so a host run is recorded, never read as unmeasured or L2. */
export function hostStage(stage: IsolationStage, at: Date): StageMeasurement {
  return {
    stage,
    mode: "host",
    measured_at: at.toISOString(),
    facts: null,
    checks: null,
    level: "L1",
    violations: ["no_container"],
    facts_sha256: measurementHash(stage, "host", null, null),
  };
}
