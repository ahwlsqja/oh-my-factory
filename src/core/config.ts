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

export interface OmfConfig {
  isolation: { declared: "L2" };
  roles: Record<RoleName, { vendor: Vendor; model?: string; effort?: string }>;
  reconciler: ReconcilerConfig;
  w: WConfig;
  judge: JudgeConfig;
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
};

interface RawConfig {
  isolation?: { declared?: "L2" };
  roles?: Partial<Record<RoleName, { vendor?: Vendor; model?: string; effort?: string }>>;
  reconciler?: Partial<ReconcilerConfig>;
  w?: Partial<WConfig>;
  judge?: Partial<JudgeConfig>;
}

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
  // A tag can be re-pointed under the judge, so an unpinned image is refused with its name before the schema runs.
  const judgeTable = table(root, "judge");
  for (const key of ["sut_base_image", "harness_base_image"] as const) {
    const value = judgeTable?.[key];
    if (typeof value === "string" && !isDigestPinned(value)) {
      throw new ConfigError(`judge.${key} must be pinned by digest`);
    }
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
  return {
    isolation: { ...CONFIG_DEFAULTS.isolation, ...raw.isolation },
    roles,
    reconciler,
    w: { ...CONFIG_DEFAULTS.w, ...raw.w },
    judge,
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
