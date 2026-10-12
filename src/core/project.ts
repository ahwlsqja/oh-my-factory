import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger, type LedgerEvent, type VerifyResult } from "./ledger.js";
import { type ProjectLocation, resolveProject } from "./paths.js";

export const PROJECT_SUBDIRS = ["vault/metrics", "vault/scenarios", "runs", "worktrees"] as const;

export const DEFAULT_CONFIG = `# oh-my-factory project configuration (host state; never inside the repository)

[isolation]
declared = "L2"

[roles]
author = { vendor = "codex" }
implementer = { vendor = "claude" }
judge = { vendor = "codex" }
reconciler = { vendor = "claude" }
`;

export const PROJECT_INITIALIZED = "project.initialized";

export const NOT_INITIALIZED_MESSAGE = "project not initialized; run omf init";

/** The one meaning of "initialized": the verified ledger holds project.initialized. */
export function isInitialized(events: readonly LedgerEvent[]): boolean {
  return events.some((event) => event.type === PROJECT_INITIALIZED);
}

export interface ProjectStatus extends ProjectLocation {
  /** Null when ledger.jsonl does not exist. */
  ledger: VerifyResult | null;
  initialized: boolean;
}

/** Reads the project's ledger once and decides whether the project is initialized. Writes nothing. */
export function readProjectStatus(location: ProjectLocation): ProjectStatus {
  const file = join(location.dir, "ledger.jsonl");
  if (!existsSync(file)) return { ...location, ledger: null, initialized: false };
  const { result, events } = new Ledger(location.dir).inspect();
  return { ...location, ledger: result, initialized: result.ok && isInitialized(events) };
}

export interface InitResult {
  projectDir: string;
  repo: string;
  created: boolean;
  event: LedgerEvent | null;
}

/** Signals, inside the ledger lock, that the project already has its first event. */
class AlreadyInitialized extends Error {}

export function initProject(cwd: string, env: NodeJS.ProcessEnv = process.env): InitResult {
  const { repo, id, dir } = resolveProject(cwd, env);

  // Creating the layout is idempotent, so every init also repairs missing directories.
  for (const sub of PROJECT_SUBDIRS) mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
  const configPath = join(dir, "config.toml");
  if (!existsSync(configPath)) writeFileSync(configPath, DEFAULT_CONFIG, { mode: 0o600 });

  // "Initialized" is decided by isInitialized, under the ledger lock. A crash that left only a torn
  // first line is therefore not mistaken for an initialized project, and two concurrent inits write
  // the event once.
  try {
    const event = new Ledger(dir).appendWith((events) => {
      if (isInitialized(events)) throw new AlreadyInitialized();
      return { actor: "omf", type: PROJECT_INITIALIZED, payload: { repo, project_id: id } };
    });
    return { projectDir: dir, repo, created: true, event };
  } catch (err) {
    if (err instanceof AlreadyInitialized) return { projectDir: dir, repo, created: false, event: null };
    throw err;
  }
}
