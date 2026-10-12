import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
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

export interface OmfConfig {
  isolation: { declared: "L2" };
  roles: Record<RoleName, { vendor: Vendor; model?: string; effort?: string }>;
  reconciler: ReconcilerConfig;
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
};

interface RawConfig {
  isolation?: { declared?: "L2" };
  roles?: Partial<Record<RoleName, { vendor?: Vendor; model?: string; effort?: string }>>;
  reconciler?: Partial<ReconcilerConfig>;
}

function table(parent: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = parent?.[key];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
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
  if (reconcilerTable?.auth === "login_file") throw new ConfigError('reconciler.auth "login_file" needs a container; M3');
  if (table(table(root, "roles"), "reconciler")?.vendor === "codex") {
    throw new ConfigError('roles.reconciler.vendor "codex" needs a container; M3');
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
  return { isolation: { ...CONFIG_DEFAULTS.isolation, ...raw.isolation }, roles, reconciler };
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
