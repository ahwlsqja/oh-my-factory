import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger, type VerifyResult } from "./ledger.js";
import {
  NotAGitRepoError,
  UnsupportedRepoError,
  assertOutsideRepo,
  omfHome,
  projectId,
  repoToplevel,
} from "./paths.js";

export interface ToolProbe {
  found: boolean;
  version: string | null;
}

export interface PreflightReport {
  schema_version: 1;
  generated_at: string;
  tools: {
    git: ToolProbe;
    docker: ToolProbe & { daemon: boolean };
    claude: ToolProbe;
    codex: ToolProbe;
  };
  repo: { is_git_repo: boolean; toplevel: string | null };
  project: { initialized: boolean; dir: string | null; ledger: VerifyResult | null };
  isolation: { declared: "L2"; measured: "unmeasured"; note: string };
  ok: boolean;
  problems: string[];
}

/** Runs `cmd args` with PATH taken from `env`; any failure means "not usable". */
function probe(cmd: string, args: string[], env: NodeJS.ProcessEnv): ToolProbe {
  const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", env });
  if (result.error || result.status !== 0) return { found: false, version: null };
  const first = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n")[0] ?? "";
  return { found: true, version: first.length > 0 ? first : null };
}

export function runDoctor(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): PreflightReport {
  const problems: string[] = [];

  const git = probe("git", ["--version"], env);
  const docker = probe("docker", ["--version"], env);
  const daemon = docker.found ? probe("docker", ["info", "--format", "{{.ServerVersion}}"], env).found : false;
  const claude = probe("claude", ["--version"], env);
  const codex = probe("codex", ["--version"], env);
  const tools: Array<[string, ToolProbe]> = [
    ["git", git],
    ["docker", docker],
    ["claude", claude],
    ["codex", codex],
  ];
  for (const [name, tool] of tools) if (!tool.found) problems.push(`${name} not found on PATH`);
  if (docker.found && !daemon) problems.push("docker daemon is not reachable");

  let toplevel: string | null = null;
  try {
    toplevel = repoToplevel(cwd);
  } catch (err) {
    if (err instanceof UnsupportedRepoError) {
      problems.push(err.message);
    } else if (err instanceof NotAGitRepoError) {
      problems.push("not inside a git repository");
    } else {
      throw err;
    }
  }

  let dir: string | null = null;
  let initialized = false;
  let ledgerResult: VerifyResult | null = null;
  if (toplevel !== null) {
    let candidate: string | null = null;
    try {
      candidate = join(omfHome(env), "projects", projectId(toplevel));
      assertOutsideRepo(candidate, toplevel);
    } catch (err) {
      problems.push((err as Error).message);
      candidate = null;
    }
    if (candidate !== null) {
      dir = candidate;
      const ledger = new Ledger(dir);
      initialized = existsSync(ledger.file);
      if (initialized) {
        ledgerResult = ledger.verify();
        if (!ledgerResult.ok) problems.push(`ledger corrupt at seq ${ledgerResult.seq}: ${ledgerResult.reason}`);
      } else {
        problems.push("project not initialized; run omf init");
      }
    }
  }

  const report: PreflightReport = {
    schema_version: 1,
    generated_at: now().toISOString(),
    tools: { git, docker: { ...docker, daemon }, claude, codex },
    repo: { is_git_repo: toplevel !== null, toplevel },
    project: { initialized, dir, ledger: ledgerResult },
    isolation: {
      declared: "L2",
      measured: "unmeasured",
      note: "isolation is measured from M3 onward; until then no sealing guarantee is claimed",
    },
    ok: problems.length === 0,
    problems,
  };
  if (initialized && dir !== null) {
    writeFileSync(join(dir, "preflight.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  return report;
}
