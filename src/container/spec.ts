import type { AuthorConfig, ImplementerConfig, JudgeConfig } from "../core/config.js";
import { type PinnedImage, isDigestPinned } from "./image-ref.js";
import { PROBE_TIMEOUT_MS } from "./probe-timeout.js";

/** The containers OMF starts: three judge roles, the implementer and the sealing author. */
export const CONTAINER_ROLES = ["sut", "harness", "workcopy", "implementer", "author"] as const;
export type ContainerRole = (typeof CONTAINER_ROLES)[number];

/** The isolation stage a role is measured under. A work copy runs candidate code from the SUT base, so it is `sut` (spec §7). */
export const ROLE_STAGE: Readonly<Record<ContainerRole, "sut" | "harness" | "implementer" | "author">> = {
  sut: "sut",
  harness: "harness",
  workcopy: "sut",
  implementer: "implementer",
  author: "author",
};

/** The two agent roles are the only ones on a network (`bridge`, so the vendor CLI can reach its API; spec §7 L2). */
export const ROLE_NETWORK: Readonly<Record<ContainerRole, "none" | "bridge">> = {
  sut: "none",
  harness: "none",
  workcopy: "none",
  implementer: "bridge",
  author: "bridge",
};

/** An unprivileged user that owns nothing on the host; the golden facts pin this value. */
export const SANDBOX_USER = "65532:65532";
/** Containers idle until `docker exec` gives them work. The base image must ship `sleep` (a stated limit). */
export const IDLE_ENTRYPOINT = "sleep";
/** The longest a container may sleep: `assertSpec` refuses a longer lifetime. */
export const MAX_LIFETIME_S = 2147483647;

/**
 * Seconds of slack on top of an agent container's own bounds: the daemon's start-up, the time between the host's
 * calls and the cap of each. The container stops itself this long after the last bound it can legitimately need.
 */
export const AGENT_LIFETIME_MARGIN_S = 60;
/**
 * The caps of the execs one author container serves besides the model call, in seconds: the isolation probe (15), the two
 * `tar -x` uploads (30 each) and the answer read (30).
 */
export const AUTHOR_STEPS_S = 15 + 30 + 30 + 30;
/**
 * The caps of the execs one implementer container serves besides the session, in seconds: the isolation probe (15), the
 * settings write (30), the workspace preparation (a 30 s tool check and four 120 s steps), the process kill (30), the
 * capture (300) and the finalize (120).
 */
export const IMPLEMENTER_STEPS_S = 15 + 30 + (30 + 4 * 120) + 30 + 300 + 120;

/** The isolation probe `createMeasured` runs in every container, seconds (its cap, `PROBE_TIMEOUT_MS`). */
export const JUDGE_PROBE_S = PROBE_TIMEOUT_MS / 1000;
/**
 * The scenario bounds the judge lifetimes are sized from: at most this many steps in a scenario and scenarios in a set.
 * Copies of `MAX_STEPS` and `MAX_SCENARIOS_PER_SET` in src/scenario/types.ts so the container layer imports nothing from
 * there; tests/container/judge-lifetime.test.ts pins both.
 */
export const JUDGE_MAX_STEPS = 12;
export const JUDGE_MAX_SCENARIOS = 100;
/**
 * The caps of the two execs that boot a work copy, seconds: the `tar -x` upload and the declared build. Copies of
 * `EXTRACT_TIMEOUT_MS` and `BUILD_TIMEOUT_MS` in work-copy.ts, which imports this module; tests/container/judge-lifetime.test.ts pins them.
 */
export const WORKCOPY_BOOT_S = 120 + 600;
/**
 * The most gate execs one work copy container is sized to serve, and the cap of each, seconds. A stale copy gets a fresh container.
 * `WORKCOPY_GATE_EXEC_S` is the default timeout of `runGates` and `proveTest`, and `ContainerWorkCopy.run` clamps every
 * injected timeout to it, so no gate exec outruns it; the test pins all three together.
 */
export const WORKCOPY_GATE_EXECS = 32;
export const WORKCOPY_GATE_EXEC_S = 600;

/**
 * The cap of one docker call that creates, inspects, starts or removes a container, seconds. A copy of `META_MS` in
 * docker-cli.ts, which imports this module; tests/container/judge-lifetime.test.ts pins the two together.
 */
export const JUDGE_DOCKER_CALL_S = 60;
/**
 * The calls the code makes, counted line by line from src/judge/relay.ts, src/judge/round.ts, src/container/measure.ts and
 * src/container/work-copy.ts. A "step" is one scenario step relayed to a SUT; an "exec call" runs at `judge.step_timeout_ms`,
 * a "docker call" at `JUDGE_DOCKER_CALL_S`.
 */
/** Per step: the `exec` of the step and the harness `observe`, both exec calls. */
export const JUDGE_STEP_EXEC_CALLS = 2;
/** Per step: the `isRunning` inspect the relay makes after a non-zero exit (counted for every step). */
export const JUDGE_STEP_DOCKER_CALLS = 1;
/** Per SUT after its start: the remove of `stop` (a cut or killed step) and the remove of `close`. */
export const JUDGE_SUT_END_DOCKER_CALLS = 2;
/** Per SUT before its start, made by the harness lifetime clock: create, inspect, start. */
export const JUDGE_SUT_BOOT_DOCKER_CALLS = 3;
/** Per (rep, scenario): the harness `begin`, an exec call. */
export const JUDGE_BEGIN_EXEC_CALLS = 1;
/** Per round: the harness `load` and `verdict`, exec calls. */
export const JUDGE_ROUND_EXEC_CALLS = 2;
/** Per round: the harness own create, start and remove, docker calls. */
export const JUDGE_ROUND_DOCKER_CALLS = 3;
/** Per work copy gate exec: the inspect after a non-zero exit, a docker call, counted for every exec. */
export const WORKCOPY_EXEC_DOCKER_CALLS = 1;
/** Per work copy container: its remove, a docker call. */
export const WORKCOPY_END_DOCKER_CALLS = 1;
/**
 * A judge bound is the computed worst case times this factor, plus the margin. The worst case adds up caps that the host
 * reaches one after the other; the factor covers the daemon's own latency between them.
 */
export const JUDGE_SAFETY_FACTOR = 1.5;

const boundOf = (worstS: number): number =>
  Math.min(MAX_LIFETIME_S, Math.ceil(JUDGE_SAFETY_FACTOR * worstS) + AGENT_LIFETIME_MARGIN_S);

/** The seconds one relayed step can take: its exec and observe at the step cap, and the state check. */
const stepSeconds = (stepS: number): number =>
  JUDGE_STEP_EXEC_CALLS * stepS + JUDGE_STEP_DOCKER_CALLS * JUDGE_DOCKER_CALL_S;
/** The worst case of one SUT container from its start: the probe, every step, and both removes. */
const sutSeconds = (stepS: number): number =>
  JUDGE_PROBE_S + JUDGE_MAX_STEPS * stepSeconds(stepS) + JUDGE_SUT_END_DOCKER_CALLS * JUDGE_DOCKER_CALL_S;

/**
 * How long a judge container sleeps before it stops itself, so a run killed by SIGKILL cannot leave one behind for ever
 * (the next item sweep removes it earlier). The bound is wall-clock time from the container start, so it is sized from
 * everything the host does while the container is alive, each call at its cap, times `JUDGE_SAFETY_FACTOR`, plus the margin:
 * - sut serves one scenario: the probe, and at most `JUDGE_MAX_STEPS` steps of an exec, an `observe` and a state check, then
 *   the two removes (`JUDGE_STEP_*` and `JUDGE_SUT_END_DOCKER_CALLS`);
 * - harness stays alive for the whole round: the probe, `load`, `verdict`, its own create, start and remove, and for each of
 *   `judge.k` reps of up to `JUDGE_MAX_SCENARIOS` scenarios a `begin`, the SUT's create, inspect and start, and the SUT's own
 *   worst case above;
 * - workcopy serves a tree and is replaced after `WORKCOPY_GATE_EXECS` execs: the probe, the boot caps, that many gate
 *   execs at `WORKCOPY_GATE_EXEC_S` each followed by a state check, and the remove.
 * Never more than `MAX_LIFETIME_S`. An agent role has no judge lifetime (null).
 */
export function judgeLifetimeSeconds(role: ContainerRole, limits: RoleLimits): number | null {
  if (role === "author" || role === "implementer") return null;
  if (limits.kind !== "judge") throw new ContainerSpecError("invalid_limits");
  const stepS = Math.ceil(limits.judge.step_timeout_ms / 1000);
  if (role === "sut") return boundOf(sutSeconds(stepS));
  if (role === "workcopy") {
    const exec = WORKCOPY_GATE_EXEC_S + WORKCOPY_EXEC_DOCKER_CALLS * JUDGE_DOCKER_CALL_S;
    return boundOf(
      JUDGE_PROBE_S + WORKCOPY_BOOT_S + WORKCOPY_GATE_EXECS * exec + WORKCOPY_END_DOCKER_CALLS * JUDGE_DOCKER_CALL_S,
    );
  }
  const each = JUDGE_BEGIN_EXEC_CALLS * stepS + JUDGE_SUT_BOOT_DOCKER_CALLS * JUDGE_DOCKER_CALL_S + sutSeconds(stepS);
  return boundOf(
    JUDGE_ROUND_EXEC_CALLS * stepS +
      JUDGE_PROBE_S +
      JUDGE_ROUND_DOCKER_CALLS * JUDGE_DOCKER_CALL_S +
      limits.judge.k * JUDGE_MAX_SCENARIOS * each,
  );
}

/** The lifetime of any role: `agentLifetimeSeconds` for the agents, `judgeLifetimeSeconds` for the judge roles. */
export function roleLifetimeSeconds(role: ContainerRole, limits: RoleLimits): number {
  const seconds = agentLifetimeSeconds(role, limits) ?? judgeLifetimeSeconds(role, limits);
  if (seconds === null) throw new ContainerSpecError("invalid_limits");
  return seconds;
}

/**
 * How long an agent container sleeps before it stops itself, so a host killed by SIGKILL cannot leave a container with a
 * network and a vendor CLI running past its cap. The configured wall-time bound of the one model call, the caps of the other
 * execs the container serves, and a margin. A judge role has no such bound (null).
 */
export function agentLifetimeSeconds(role: ContainerRole, limits: RoleLimits): number | null {
  if (role === "author") {
    if (limits.kind !== "author") throw new ContainerSpecError("invalid_limits");
    return Math.ceil(limits.author.timeout_ms / 1000) + AUTHOR_STEPS_S + AGENT_LIFETIME_MARGIN_S;
  }
  if (role === "implementer") {
    if (limits.kind !== "implementer") throw new ContainerSpecError("invalid_limits");
    return Math.ceil(limits.implementer.timeout_ms / 1000) + IMPLEMENTER_STEPS_S + AGENT_LIFETIME_MARGIN_S;
  }
  return null;
}

/**
 * The create-time environment of the implementer: names and values are constants of this module, never caller input
 * (`ContainerSpec` still cannot express an env value). `HOME` and `CLAUDE_CONFIG_DIR` point into the owned `/agent` tmpfs, so
 * the vendor CLI finds no login to read; the git identity lets a plain `git commit` work for uid 65532 in a read-only root.
 * The secret is not here: it appears only as a name at `docker exec` time.
 */
export const IMPLEMENTER_FIXED_ENV: readonly (readonly [name: string, value: string])[] = [
  ["HOME", "/agent"],
  ["CLAUDE_CONFIG_DIR", "/agent/claude"],
  ["DISABLE_AUTOUPDATER", "1"],
  ["DISABLE_TELEMETRY", "1"],
  ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"],
  ["NO_COLOR", "1"],
  ["OMF_TMP", "/tmp"],
  ["GIT_AUTHOR_NAME", "omf-implementer"],
  ["GIT_AUTHOR_EMAIL", "omf-implementer@invalid"],
  ["GIT_COMMITTER_NAME", "omf-implementer"],
  ["GIT_COMMITTER_EMAIL", "omf-implementer@invalid"],
];
/** The names of `IMPLEMENTER_FIXED_ENV`, sorted: what the implementer golden adds to the image's own names. */
export const IMPLEMENTER_ENV_NAMES: readonly string[] = IMPLEMENTER_FIXED_ENV.map(([name]) => name).sort();

/**
 * The create-time environment of the sealing author. Same rule as the implementer's: names and values are constants of this
 * module, never caller input. `HOME` and `CODEX_HOME` point into the owned `/agent` tmpfs, so the vendor CLI finds no login to
 * read and writes its own state nowhere else. A name given at create overrides the image's own value, so an image cannot
 * choose where the CLI keeps its home. The key is not here: it appears only as a name at `docker exec` time.
 */
export const AUTHOR_FIXED_ENV: readonly (readonly [name: string, value: string])[] = [
  ["HOME", "/agent"],
  ["CODEX_HOME", "/agent/codex"],
  ["NO_COLOR", "1"],
  ["OMF_TMP", "/tmp"],
];
/** The names of `AUTHOR_FIXED_ENV`, sorted: what the author golden adds to the image's own names. */
export const AUTHOR_ENV_NAMES: readonly string[] = AUTHOR_FIXED_ENV.map(([name]) => name).sort();

/**
 * The only environment variable names an exec may inherit from the OMF process, and only through a `SecretHandle`:
 * the value is read by the docker client from its own environment and never appears in an argv or a create-time
 * setting. A name outside this set can never be passed on. Each name belongs to one role (ROLE_SECRET).
 */
export const SECRET_ENV_NAMES = ["ANTHROPIC_API_KEY", "CODEX_API_KEY"] as const;
export type SecretEnvName = (typeof SECRET_ENV_NAMES)[number];

/**
 * Which secret a role's exec may carry, and so which roles may carry one at all. Candidate code runs in the judge roles and can
 * read whatever its container is given; only the two agent roles, each measured for that before the key is handed over, ever
 * receive a key, and each only its own vendor's. Any other pairing is refused by the runtime before a process starts, and so
 * is a handle that `createMeasured` did not return (`measured-handles.ts`).
 */
export const ROLE_SECRET: Readonly<Partial<Record<ContainerRole, SecretEnvName>>> = {
  implementer: "ANTHROPIC_API_KEY",
  author: "CODEX_API_KEY",
};

/**
 * Closed set of credential-shaped variable names. An implementer or author image that declares any of them (or any name of
 * `SECRET_ENV_NAMES`) is never allowed by the golden: the owner builds the image, and a key baked into it would
 * reach every container made from it. A credential under a name outside this set is not recognised by name.
 */
export const CREDENTIAL_SHAPED_ENV_NAMES: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "CODEX_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_HOME",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
  "HF_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
];

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
  destination: "/tmp" | "/scratch" | "/state" | "/work" | "/agent" | "/in" | "/out";
  size_mb: number;
  exec: boolean;
  /** Owned by the sandbox user (uid and gid 65532); otherwise root-owned. */
  owned: boolean;
}

/**
 * Everything `docker create` may be told. There is deliberately no field for a mount, a volume, a privilege, a
 * capability, a device, a PID or IPC share, a network, a published port or an environment value: the argv builder
 * cannot emit what this type cannot express.
 */
export interface ContainerSpec {
  name: string;
  image: PinnedImage | ImageId;
  labels: OwnedLabels;
  tmpfs: readonly TmpfsSpec[];
  limits: { memory_mb: number; cpus: number; pids: number };
  /**
   * Seconds the container sleeps before it stops itself (`roleLifetimeSeconds`). Required for every role: no container sleeps
   * for ever.
   */
  lifetime_s: number;
}

// The run id pattern of the W events and the work id pattern of the W verbs, repeated here so the container layer imports
// nothing from `work/`; tests/container/argv.test.ts pins the run id copy to `RUN_ID_PATTERN` in `src/work/w-events.ts`.
export const RUN_ID_RE = /^r-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{4}$/;
export const WORK_ID_RE = /^w-[0-9a-f]{12}$/;
const NAME_RE = /^omf-(sut|harness|workcopy|implementer|author)-r-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{4}-[0-9]+-[0-9]+$/;
const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;
const CONTEXT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** A reference that is safe to hand to `docker image inspect`: no leading "-", no whitespace. */
const IMAGE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,254}$/;
const CPUS_RE = /^[0-9]+(\.[0-9]{1,2})?$/;
const TMPFS_DESTINATIONS: readonly string[] = ["/tmp", "/scratch", "/state", "/work", "/agent", "/in", "/out"];

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
  const { lifetime_s: lifetime } = spec;
  if (!(Number.isInteger(lifetime) && lifetime >= 1 && lifetime <= MAX_LIFETIME_S)) {
    throw new ContainerSpecError("invalid_limits");
  }
}

/**
 * The scratch filesystems of a role, all tmpfs and all owned by the sandbox user. Nothing persists past the container,
 * and no role has a bind mount: the harness receives its scenarios over stdin, a work copy its tree through `tar -x` on
 * stdin (spec §7), and the author its three inputs the same way into `/in`. Only `/work` is executable (a work copy runs the
 * declared gates there, the implementer builds and runs its tree there).
 */
export function roleTmpfs(role: ContainerRole, limits: RoleLimits): TmpfsSpec[] {
  if (role === "author") {
    // /in holds the item's intent, spec and interface contract; /out holds the answer; /agent is the vendor CLI's own home.
    // Nothing the author is given or writes can execute.
    if (limits.kind !== "author") throw new ContainerSpecError("invalid_limits");
    const sizes = limits.author;
    return [
      { destination: "/tmp", size_mb: sizes.tmp_tmpfs_mb, exec: false, owned: true },
      { destination: "/in", size_mb: sizes.in_tmpfs_mb, exec: false, owned: true },
      { destination: "/out", size_mb: sizes.out_tmpfs_mb, exec: false, owned: true },
      { destination: "/agent", size_mb: sizes.agent_tmpfs_mb, exec: false, owned: true },
    ];
  }
  if (role === "implementer") {
    // Executable /work holds the tree the implementer builds and runs; /agent holds the vendor CLI's own state.
    if (limits.kind !== "implementer") throw new ContainerSpecError("invalid_limits");
    const sizes = limits.implementer;
    return [
      { destination: "/tmp", size_mb: sizes.tmp_tmpfs_mb, exec: false, owned: true },
      { destination: "/work", size_mb: sizes.work_tmpfs_mb, exec: true, owned: true },
      { destination: "/agent", size_mb: sizes.agent_tmpfs_mb, exec: false, owned: true },
    ];
  }
  if (limits.kind !== "judge") throw new ContainerSpecError("invalid_limits");
  const sizes = limits.judge;
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

/**
 * Typed discriminant for what a role reads its sizes and limits from: the judge roles read `[judge]`, the implementer reads
 * `[implementer]`, the author reads `[author]`. A mismatch is a bug in the caller and is refused (`invalid_limits`) before
 * any spec exists.
 */
export type RoleLimits =
  | { kind: "judge"; judge: JudgeConfig }
  | { kind: "implementer"; implementer: ImplementerConfig }
  | { kind: "author"; author: AuthorConfig };

/** The memory, cpu and pid limits of a role, from the config table that role reads. */
export function roleLimits(role: ContainerRole, limits: RoleLimits): ContainerSpec["limits"] {
  if (role === "implementer") {
    if (limits.kind !== "implementer") throw new ContainerSpecError("invalid_limits");
    const { memory_mb, cpus, pids_limit } = limits.implementer;
    return { memory_mb, cpus, pids: pids_limit };
  }
  if (role === "author") {
    if (limits.kind !== "author") throw new ContainerSpecError("invalid_limits");
    const { memory_mb, cpus, pids_limit } = limits.author;
    return { memory_mb, cpus, pids: pids_limit };
  }
  if (limits.kind !== "judge") throw new ContainerSpecError("invalid_limits");
  const { memory_mb, cpus, pids_limit } = limits.judge;
  return { memory_mb, cpus, pids: pids_limit };
}
