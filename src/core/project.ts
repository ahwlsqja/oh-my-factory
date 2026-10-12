import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger, LedgerCorruptError, type LedgerEvent } from "./ledger.js";
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

export function initProject(cwd: string, env: NodeJS.ProcessEnv = process.env): InitResult {
  const repo = repoToplevel(cwd);
  const id = projectId(repo);
  const dir = join(omfHome(env), "projects", id);
  assertOutsideRepo(dir, repo);
  const ledger = new Ledger(dir);

  if (existsSync(ledger.file)) {
    const state = ledger.verify();
    if (!state.ok) throw new LedgerCorruptError(state.seq, state.reason);
    return { projectDir: dir, repo, created: false, event: null };
  }

  for (const sub of PROJECT_SUBDIRS) mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
  const configPath = join(dir, "config.toml");
  if (!existsSync(configPath)) writeFileSync(configPath, DEFAULT_CONFIG, { mode: 0o600 });
  const event = ledger.append({ actor: "omf", type: "project.initialized", payload: { repo, project_id: id } });
  return { projectDir: dir, repo, created: true, event };
}
