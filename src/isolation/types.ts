/**
 * Isolation measurement vocabulary.
 *
 * A level is only ever a measurement of a container that existed: L2 means "zero violations against
 * the stage's golden values", L1 means anything else, including a run on the host. L3 is in the order
 * and in the schema so records written later still validate; nothing in v0.1 emits it. `unmeasured`
 * is the lowest rung, so a stage nobody measured can never lift the run.
 */
export const ISOLATION_LEVELS = ["L1", "L2", "L3"] as const;
export type IsolationLevel = (typeof ISOLATION_LEVELS)[number];
export type MeasuredLevel = IsolationLevel | "unmeasured";

const RANK: Record<MeasuredLevel, number> = { unmeasured: 0, L1: 1, L2: 2, L3: 3 };

export function compareLevel(a: MeasuredLevel, b: MeasuredLevel): -1 | 0 | 1 {
  const difference = RANK[a] - RANK[b];
  return difference < 0 ? -1 : difference > 0 ? 1 : 0;
}

/** The lowest level in the list. An empty list is `unmeasured`, never a default of L2. */
export function minLevel(levels: readonly MeasuredLevel[]): MeasuredLevel {
  const [first, ...rest] = levels;
  if (first === undefined) return "unmeasured";
  let lowest: MeasuredLevel = first;
  for (const level of rest) if (compareLevel(level, lowest) < 0) lowest = level;
  return lowest;
}

export const ISOLATION_STAGES = ["author", "implementer", "sut", "harness"] as const;
export type IsolationStage = (typeof ISOLATION_STAGES)[number];

export interface MountFact {
  type: "bind" | "volume" | "tmpfs" | "other";
  source: string;
  destination: string;
  read_only: boolean;
}

export interface ContainerFacts {
  container_id: string;
  image: string;
  mounts: MountFact[];
  /** Names only. Values are never read, so a credential in the environment cannot reach a record. */
  env_names: string[];
  cap_add: string[];
  cap_drop: string[];
  privileged: boolean;
  network_mode: string;
  pid_mode: string;
  user: string;
  read_only_rootfs: boolean;
  /** Every field from here down is required: a missing one throws InspectParseError instead of defaulting to the safe value. */
  security_opt: string[];
  devices: string[];
  ipc_mode: string;
  uts_mode: string;
  userns_mode: string;
  /** Recorded for the audit trail. The contract has no violation code for it. */
  cgroupns_mode: string;
  volumes_from: string[];
  sysctls: string[];
  runtime: string;
  /**
   * `HostConfig.Init`: the create argv says `--init=false`, so the daemon reports false even when it is configured with `init: true`.
   * `null` is the key unset (omitted by the daemon), which leaves the daemon default in force and so is not golden.
   */
  init: boolean | null;
}

/** What an in-container probe found. */
export interface ContainerChecks {
  vendor_binaries: string[];
  credential_paths: string[];
  docker_socket_present: boolean;
}

/** The order here is the order violations are reported in. */
export const VIOLATION_CODES = [
  "no_container",
  "docker_socket_mounted",
  "docker_socket_present",
  "privileged",
  "cap_added",
  "caps_not_dropped",
  "host_network",
  "network_not_none",
  "host_pid",
  "root_user",
  "rootfs_writable",
  "unexpected_mount",
  "mount_not_read_only",
  "forbidden_mount_source",
  "unexpected_env_name",
  "vendor_binary_present",
  "credential_present",
  "no_new_privileges_missing",
  "security_opt_unconfined",
  "device_mapped",
  "host_ipc",
  "host_uts",
  "userns_host",
  "volumes_from",
  "sysctl_set",
  "runtime_unexpected",
  "init_not_disabled",
] as const;
export type ViolationCode = (typeof VIOLATION_CODES)[number];

export interface StageMeasurement {
  stage: IsolationStage;
  mode: "container" | "host";
  measured_at: string;
  facts: ContainerFacts | null;
  checks: ContainerChecks | null;
  /** L2 when `violations` is empty, else L1. L3 is never emitted in v0.1. */
  level: IsolationLevel;
  violations: ViolationCode[];
  /** sha256 of canonicalize({ stage, mode, facts, checks }). */
  facts_sha256: string;
}

/** A stage may be measured many times in one run: SUT and harness containers are recreated every round. */
export interface StageSummary {
  level: IsolationLevel;
  measurements: number;
  violations: ViolationCode[];
  facts_sha256s: string[];
}

export interface RunIsolation {
  run_id: string;
  stages: Record<IsolationStage, StageSummary | null>;
  level: MeasuredLevel;
  complete: boolean;
}

/**
 * Whether a recorded level agrees with the rest of its record. L2 needs a container run with no
 * violation, a host run is never above L1, and L3 does not exist in v0.1. A record that disagrees with
 * itself was edited or produced by something other than the evaluator.
 */
function levelIsConsistent(entry: StageMeasurement): boolean {
  if (entry.level === "L3") return false;
  if (entry.level === "L2") return entry.mode === "container" && entry.violations.length === 0;
  return entry.level === "L1";
}

/**
 * Stage level = the minimum over EVERY measurement of that stage in the run, not the latest: an L1
 * container in round 1 followed by an L2 container in round 2 stays L1. Run level = the
 * minimum over the four stage levels, a missing stage counting as `unmeasured`, so no label above
 * `unmeasured` exists until all four stages were measured. A stage with any record whose level its own
 * violations or mode do not support is shown as L1 and counts as `unmeasured` for the run.
 */
export function runIsolation(runId: string, measurements: readonly StageMeasurement[]): RunIsolation {
  const stages: Record<IsolationStage, StageSummary | null> = {
    author: null,
    implementer: null,
    sut: null,
    harness: null,
  };
  const untrusted = new Set<IsolationStage>();
  for (const stage of ISOLATION_STAGES) {
    const [first, ...rest] = measurements.filter((entry) => entry.stage === stage);
    if (first === undefined) continue;
    let level: IsolationLevel = first.level;
    let trusted = true;
    const seen = new Set<ViolationCode>();
    const hashes: string[] = [];
    for (const entry of [first, ...rest]) {
      if (!levelIsConsistent(entry)) trusted = false;
      if (compareLevel(entry.level, level) < 0) level = entry.level;
      for (const code of entry.violations) seen.add(code);
      if (!hashes.includes(entry.facts_sha256)) hashes.push(entry.facts_sha256);
    }
    if (!trusted) {
      level = "L1";
      untrusted.add(stage);
    }
    stages[stage] = {
      level,
      measurements: rest.length + 1,
      violations: VIOLATION_CODES.filter((code) => seen.has(code)),
      facts_sha256s: hashes,
    };
  }
  const levels = ISOLATION_STAGES.map(
    (stage): MeasuredLevel => (untrusted.has(stage) ? "unmeasured" : (stages[stage]?.level ?? "unmeasured")),
  );
  return {
    run_id: runId,
    stages,
    level: minLevel(levels),
    complete: ISOLATION_STAGES.every((stage) => stages[stage] !== null),
  };
}
