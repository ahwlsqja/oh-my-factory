import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { isDigestPinned } from "../container/image-ref.js";
import { sha256Hex } from "./canonical-json.js";
import { validate } from "./schema.js";

export type Vendor = "claude" | "codex";
export type ReconcilerKind = "claude" | "command";
export type RoleName = "author" | "implementer" | "judge" | "reconciler";

export interface ReconcilerConfig {
  kind: ReconcilerKind;
  model: string | null;
  command: string[] | null;
  auth: "api_key";
  env_passthrough: string[];
  timeout_ms: number;
  max_budget_usd: number | null;
}

/**
 * Constants, not config, in M2b: a change to any of them would leave no ledger trace until a J8 path
 * records it, so the tables stay closed (see NOT_CONFIGURABLE).
 */
export const STOP_IF_UNREVIEWED_EVIDENCE = 3;
export const REFRESH = { max_age: "14d", max_commits: 50, max_target_move: 1.0 } as const;
export const EXTRA_HIGH_RISK_GLOBS: readonly string[] = [];

/**
 * Per-work-item limit a W line starts from (M3-D18). Task 2 copies it into a `work.limits_set` ledger event at an
 * item's first run; after that the ledger is the authority and only a recorded human act raises it, so editing
 * this table never loosens an item that already has limits.
 */
export interface WConfig {
  max_rounds: number;
  /** Dollars here for a person to read; the ledger holds integer micro-USD (M3b2-D2). */
  max_model_usd: number;
}

/**
 * The container judge (spec §5.5). The two base images are digest-pinned or absent: `null` means "not configured",
 * and a run that needs one stops with a closed reason instead of guessing. `docker_context` names the Docker
 * context every container operation uses; `null` means no container operation runs, and the client's current
 * context is never consulted. The tmpfs sizes are per mount; each role's mounts are charged to `memory_mb`.
 */
export interface JudgeConfig {
  /** Repetitions per scenario. 1 cannot see a flaky scenario, so the floor is 2. */
  k: number;
  sut_base_image: string | null;
  harness_base_image: string | null;
  docker_context: string | null;
  step_timeout_ms: number;
  memory_mb: number;
  cpus: number;
  pids_limit: number;
  /** `/tmp` of every role. */
  tmp_tmpfs_mb: number;
  /** `/scratch` of the SUT. */
  scratch_tmpfs_mb: number;
  /** `/work` of a work copy. */
  work_tmpfs_mb: number;
  /** `/state` of the harness. */
  state_tmpfs_mb: number;
}

/**
 * The implementer container (Claude Code, one session per round). `image` is a digest reference or a local image
 * id (`sha256:` and 64 hex digits): a locally built image has an id but no registry digest, and both are immutable.
 * `null` means "not configured", and a run that needs the implementer stops with a closed reason instead of
 * guessing. The Docker context is `judge.docker_context`: one context serves every container. There is no key,
 * token or credential field anywhere in this table; the vendor key comes from the environment of the one command
 * that runs it and is never stored. The tmpfs sizes are per mount and together are charged to `memory_mb`.
 */
export interface ImplementerConfig {
  image: string | null;
  /** One session. */
  timeout_ms: number;
  memory_mb: number;
  cpus: number;
  pids_limit: number;
  /** `/tmp`. */
  tmp_tmpfs_mb: number;
  /** `/work`: the checked-out tree and the container's own repository. */
  work_tmpfs_mb: number;
  /** `/agent`: the vendor client's home. */
  agent_tmpfs_mb: number;
  /** Cap of the session log. A verbose stream for a long session is large, hence 64 MiB. */
  max_log_bytes: number;
  /** Cap of the workspace capture and of the history scan. A cap hit is incomplete, and incomplete fails closed. */
  max_workspace_bytes: number;
}

export interface OmfConfig {
  isolation: { declared: "L2" };
  roles: Record<RoleName, { vendor: Vendor; model?: string; effort?: string }>;
  reconciler: ReconcilerConfig;
  w: WConfig;
  judge: JudgeConfig;
  implementer: ImplementerConfig;
}

export class ConfigError extends Error {}

const ROLE_NAMES: readonly RoleName[] = ["author", "implementer", "judge", "reconciler"];

/** Tables that exist as constants in M2b. Naming one in config.toml is refused rather than ignored. */
const NOT_CONFIGURABLE: readonly string[] = ["stop_if", "refresh", "risk"];

/** Applied per missing SECTION (and per missing key inside a present one); never when the file itself is missing. */
export const CONFIG_DEFAULTS: OmfConfig = {
  isolation: { declared: "L2" },
  roles: {
    author: { vendor: "codex" },
    implementer: { vendor: "claude" },
    judge: { vendor: "codex" },
    reconciler: { vendor: "claude" },
  },
  reconciler: {
    kind: "claude",
    model: null,
    command: null,
    auth: "api_key",
    env_passthrough: [],
    timeout_ms: 120_000,
    max_budget_usd: null,
  },
  // Small on purpose (M3b2-D13): the default is that a person raises the limit, not that a loop runs long.
  w: { max_rounds: 3, max_model_usd: 5 },
  judge: {
    k: 3,
    sut_base_image: null,
    harness_base_image: null,
    docker_context: null,
    step_timeout_ms: 10_000,
    memory_mb: 512,
    cpus: 1,
    pids_limit: 256,
    tmp_tmpfs_mb: 64,
    scratch_tmpfs_mb: 64,
    work_tmpfs_mb: 256,
    state_tmpfs_mb: 16,
  },
  implementer: {
    image: null,
    timeout_ms: 1_800_000,
    memory_mb: 2048,
    cpus: 2,
    pids_limit: 512,
    tmp_tmpfs_mb: 256,
    work_tmpfs_mb: 1024,
    agent_tmpfs_mb: 256,
    max_log_bytes: 64 * 1024 * 1024,
    max_workspace_bytes: 256 * 1024 * 1024,
  },
};

interface RawConfig {
  isolation?: { declared?: "L2" };
  roles?: Partial<Record<RoleName, { vendor?: Vendor; model?: string; effort?: string }>>;
  reconciler?: Partial<ReconcilerConfig>;
  w?: Partial<WConfig>;
  judge?: Partial<JudgeConfig>;
  implementer?: Partial<ImplementerConfig>;
}

/** `sha256:` and 64 lowercase hex digits, as `docker image inspect` reports a local image id. */
const LOCAL_IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

/**
 * tmpfs is charged to the container's memory, so a role whose mounts add up to more than `memory_mb` could be
 * killed for memory by writing files. Refusing the config says so before any container exists.
 */
function requireTmpfsFits(judge: JudgeConfig): void {
  const roles: [string, number][] = [
    ["sut", judge.tmp_tmpfs_mb + judge.scratch_tmpfs_mb],
    ["harness", judge.tmp_tmpfs_mb + judge.state_tmpfs_mb],
    ["workcopy", judge.tmp_tmpfs_mb + judge.work_tmpfs_mb],
  ];
  for (const [role, total] of roles) {
    if (total > judge.memory_mb) {
      throw new ConfigError(
        `judge tmpfs sizes of the ${role} container (${total} MiB) exceed judge.memory_mb (${judge.memory_mb})`,
      );
    }
  }
}

/** The same rule as the judge, for the implementer's three mounts. */
function requireImplementerTmpfsFits(implementer: ImplementerConfig): void {
  const total = implementer.tmp_tmpfs_mb + implementer.work_tmpfs_mb + implementer.agent_tmpfs_mb;
  if (total > implementer.memory_mb) {
    throw new ConfigError(
      `implementer tmpfs sizes (${total} MiB) exceed implementer.memory_mb (${implementer.memory_mb})`,
    );
  }
}

function table(parent: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = parent?.[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * TOML text -> schema validation -> defaults per missing section. Codex and `login_file` are refused before
 * the schema runs so the message says why (they need a container, M3), not just "not allowed".
 */
export function parseConfig(text: string): OmfConfig {
  let root: Record<string, unknown>;
  try {
    root = parseToml(text);
  } catch (err) {
    throw new ConfigError(`config.toml is not valid TOML: ${(err as Error).message}`);
  }
  for (const name of NOT_CONFIGURABLE) {
    if (name in root) throw new ConfigError(`[${name}] is not configurable in M2b`);
  }
  const reconcilerTable = table(root, "reconciler");
  if (reconcilerTable?.kind === "codex") throw new ConfigError('reconciler.kind "codex" needs a container; M3');
  if (reconcilerTable?.auth === "login_file")
    throw new ConfigError('reconciler.auth "login_file" needs a container; M3');
  if (table(table(root, "roles"), "reconciler")?.vendor === "codex") {
    throw new ConfigError('roles.reconciler.vendor "codex" needs a container; M3');
  }
  if (table(table(root, "roles"), "implementer")?.vendor === "codex") {
    throw new ConfigError(
      'roles.implementer.vendor "codex" is not supported: only the claude implementer runs in a container in this version',
    );
  }
  // A tag can be re-pointed under the judge, so an unpinned image is refused with its name before the schema runs.
  const judgeTable = table(root, "judge");
  for (const key of ["sut_base_image", "harness_base_image"] as const) {
    const value = judgeTable?.[key];
    if (typeof value === "string" && !isDigestPinned(value)) {
      throw new ConfigError(`judge.${key} must be pinned by digest`);
    }
  }
  // Same reason as the judge images: a tag can be re-pointed under a run. A local image id is as immutable as a digest.
  const implementerImage = table(root, "implementer")?.image;
  if (
    typeof implementerImage === "string" &&
    !isDigestPinned(implementerImage) &&
    !LOCAL_IMAGE_ID.test(implementerImage)
  ) {
    throw new ConfigError(
      "implementer.image must be pinned by digest or be a local image id (sha256: and 64 hex digits)",
    );
  }
  const checked = validate("config.schema.json", root);
  if (!checked.ok) throw new ConfigError(`config.toml is invalid: ${checked.errors}`);

  const raw = root as RawConfig;
  const roles = {} as OmfConfig["roles"];
  for (const name of ROLE_NAMES) roles[name] = { ...CONFIG_DEFAULTS.roles[name], ...raw.roles?.[name] };
  const reconciler: ReconcilerConfig = { ...CONFIG_DEFAULTS.reconciler, ...raw.reconciler };
  reconciler.env_passthrough = [...reconciler.env_passthrough];
  if (reconciler.kind === "command" && reconciler.command === null) {
    throw new ConfigError('reconciler.kind "command" requires reconciler.command');
  }
  const judge: JudgeConfig = { ...CONFIG_DEFAULTS.judge, ...raw.judge };
  requireTmpfsFits(judge);
  const implementer: ImplementerConfig = { ...CONFIG_DEFAULTS.implementer, ...raw.implementer };
  requireImplementerTmpfsFits(implementer);
  return {
    isolation: { ...CONFIG_DEFAULTS.isolation, ...raw.isolation },
    roles,
    reconciler,
    w: { ...CONFIG_DEFAULTS.w, ...raw.w },
    judge,
    implementer,
  };
}

function configPath(projectDir: string): string {
  return join(projectDir, "config.toml");
}

function readConfigBytes(projectDir: string): Buffer {
  const path = configPath(projectDir);
  // Spec §11.5: a configuration that cannot be read is never replaced by defaults.
  if (!existsSync(path)) throw new ConfigError("config.toml missing; run omf init");
  try {
    return readFileSync(path);
  } catch (err) {
    throw new ConfigError(`config.toml unreadable: ${(err as Error).message}`);
  }
}

export function readConfig(projectDir: string): OmfConfig {
  return parseConfig(readConfigBytes(projectDir).toString("utf8"));
}

/** sha256 of the raw file bytes. Recorded in `goal.tick_started` so an edit between ticks leaves a ledger trace. */
export function configSha256(projectDir: string): string {
  return sha256Hex(readConfigBytes(projectDir));
}
