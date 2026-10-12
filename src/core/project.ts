import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger, type LedgerEvent } from "./ledger.js";
import { assertOutsideRepo, omfHome, projectId, repoToplevel } from "./paths.js";

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

export interface InitResult {
  projectDir: string;
  repo: string;
  created: boolean;
  event: LedgerEvent | null;
}

/** Signals, inside the ledger lock, that the project already has its first event. */
class AlreadyInitialized extends Error {}

export function initProject(cwd: string, env: NodeJS.ProcessEnv = process.env): InitResult {
  const repo = repoToplevel(cwd);
  const id = projectId(repo);
  const dir = join(omfHome(env), "projects", id);
  assertOutsideRepo(dir, repo);

  // Creating the layout is idempotent, so every init also repairs missing directories.
  for (const sub of PROJECT_SUBDIRS) mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
  const configPath = join(dir, "config.toml");
  if (!existsSync(configPath)) writeFileSync(configPath, DEFAULT_CONFIG, { mode: 0o600 });

  // "Initialized" means the ledger holds project.initialized, decided under the ledger lock.
  // A crash that left only a torn first line is therefore not mistaken for an initialized project,
  // and two concurrent inits write the event once.
  try {
    const event = new Ledger(dir).appendWith((events) => {
      if (events.some((e) => e.type === "project.initialized")) throw new AlreadyInitialized();
      return { actor: "omf", type: "project.initialized", payload: { repo, project_id: id } };
    });
    return { projectDir: dir, repo, created: true, event };
  } catch (err) {
    if (err instanceof AlreadyInitialized) return { projectDir: dir, repo, created: false, event: null };
    throw err;
  }
}
