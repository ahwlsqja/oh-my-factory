import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger, type LedgerEvent, type VerifyResult } from "./ledger.js";
import { type ProjectLocation, resolveProject } from "./paths.js";
import { assertStateTreeClean } from "./safe-fs.js";

export const PROJECT_SUBDIRS = ["vault/metrics", "vault/scenarios", "runs", "worktrees", "goals"] as const;

export const DEFAULT_CONFIG = `# oh-my-factory project configuration (host state; never inside the repository)

[isolation]
declared = "L2"

[roles]
author = { vendor = "codex" }
implementer = { vendor = "claude" }
judge = { vendor = "codex" }
reconciler = { vendor = "claude" }

[w]
# Per-work-item limits, copied into the ledger at an item's first run. Raising one later is a recorded human act
# (J8), never a config edit.
max_rounds = 3
max_model_usd = 5.0

# Optional. Without this section the code defaults apply (kind "claude", 120 s timeout, no budget cap).
# [reconciler]
# kind = "claude"        # or "command"; "command" also needs command = ["node", "stub.js"]
# model = "..."          # omit for the vendor default
# timeout_ms = 120000    # 1000..600000
# max_budget_usd = 1.5

# Optional. The container judge. Without both images and a Docker context, no scenario runs in a container.
# [judge]
# k = 3                                  # repetitions per scenario, 2..10
# sut_base_image = "name@sha256:..."     # pinned by digest (64 hex digits), never a tag
# harness_base_image = "name@sha256:..."
# docker_context = "my-local-context"    # a local Docker context; the client's current context is never used
# memory_mb = 512                        # per container; tmp_tmpfs_mb, scratch_tmpfs_mb, work_tmpfs_mb and
#                                        # state_tmpfs_mb (tmpfs sizes) must fit inside it

# Optional. The implementer container (Claude Code). Without an image no implementer runs. It uses the
# docker_context of [judge].
# [implementer]
# image = "name@sha256:..."              # pinned by digest, or a local image id ("sha256:" and 64 hex digits)
# timeout_ms = 1800000                   # one session, 60000..14400000
# memory_mb = 2048                       # tmp_tmpfs_mb, work_tmpfs_mb and agent_tmpfs_mb together must fit inside it
# max_log_bytes = 67108864               # cap of the session log (64 MiB)
# The vendor key is never configured here: it is read from the environment of the one command that runs it.
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
  const ledger = new Ledger(location.dir);
  if (!existsSync(ledger.file)) return { ...location, ledger: null, initialized: false };
  const { result, events } = ledger.inspect();
  return { ...location, ledger: result, initialized: result.ok && isInitialized(events) };
}

/** What keeps a command from using the project, or null. One wording for doctor and the goal commands. */
export function projectProblem(status: ProjectStatus): string | null {
  if (status.ledger === null) return NOT_INITIALIZED_MESSAGE;
  if (!status.ledger.ok) return `ledger corrupt at seq ${status.ledger.seq}: ${status.ledger.reason}`;
  if (!status.initialized) return NOT_INITIALIZED_MESSAGE;
  return null;
}

/**
 * For commands that need an initialized project with a sound ledger. The CLI reports the error with exit 2.
 * The symlink guard runs before anything is read, so no state is read through a link. It returns quietly
 * when the OMF home does not exist, so a missing project still reads "project not initialized".
 */
export function requireProject(cwd: string, env: NodeJS.ProcessEnv = process.env): ProjectStatus {
  const location = resolveProject(cwd, env);
  assertStateTreeClean(location, env);
  const status = readProjectStatus(location);
  const problem = projectProblem(status);
  if (problem !== null) throw new Error(problem);
  return status;
}

export interface InitResult {
  projectDir: string;
  repo: string;
  created: boolean;
  event: LedgerEvent | null;
}

/** Signals, inside the ledger lock, that the project already has its first event. */
class AlreadyInitialized extends Error {}

/**
 * Pins the project's host state to its owner: directories 0700, files 0600. A mode is applied only when
 * a path is created, so this runs on every init and also fixes an existing project. OMF_HOME and
 * OMF_HOME/projects are not touched, because the user may share them.
 */
function restrictProjectModes(dir: string): void {
  chmodSync(dir, 0o700);
  for (const sub of PROJECT_SUBDIRS) {
    // Intermediate directories too: "vault/metrics" also creates "vault".
    const segments = sub.split("/");
    for (let depth = 1; depth <= segments.length; depth++) chmodSync(join(dir, ...segments.slice(0, depth)), 0o700);
  }
  for (const file of ["config.toml", "ledger.jsonl"]) {
    const path = join(dir, file);
    if (existsSync(path)) chmodSync(path, 0o600);
  }
}

export function initProject(cwd: string, env: NodeJS.ProcessEnv = process.env): InitResult {
  const location = resolveProject(cwd, env);
  const { repo, id, dir } = location;
  // Before any mkdir, chmod or write: an existing project must not be repaired through a planted link.
  assertStateTreeClean(location, env);

  // Creating the layout is idempotent, so every init also repairs missing directories.
  for (const sub of PROJECT_SUBDIRS) mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
  const configPath = join(dir, "config.toml");
  if (!existsSync(configPath)) writeFileSync(configPath, DEFAULT_CONFIG, { mode: 0o600 });
  restrictProjectModes(dir);

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
