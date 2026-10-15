import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { IsolationLevel, MeasuredLevel } from "../isolation/types.js";
import { sealedProblem } from "../vault/pokayoke.js";
import { TORN_TAIL_WARNING, type VerifyResult } from "./ledger.js";
import { NotAGitRepoError, type ProjectLocation, UnsupportedRepoError, locateProject, repoToplevel } from "./paths.js";
import { writePrivateFileAtomic } from "./private-fs.js";
import { projectProblem, readProjectStatus } from "./project.js";
import { SymlinkRefusedError, assertStateTreeClean } from "./safe-fs.js";

export interface ToolProbe {
  found: boolean;
  version: string | null;
}

/**
 * What `omf doctor` can say about isolation. It is advisory: a measurement belongs to a run and lives in the ledger
 * (`isolation.measured`), GATE-3 never reads `preflight.json`, and nothing here is enforced.
 * `unmeasurable` means the container runtime is missing or unreachable; `failure` then holds the probe's own failure text.
 */
export interface AdvisoryIsolation {
  declared: IsolationLevel;
  measured: MeasuredLevel | "unmeasurable";
  advisory: true;
  note: string;
  failure: string | null;
}

/** Synchronous like `runDoctor`. M3f supplies the real probe; the default says nothing was measured. */
export type IsolationProbe = (env: NodeJS.ProcessEnv, tools: PreflightReport["tools"]) => AdvisoryIsolation;

export const unmeasuredProbe: IsolationProbe = () => ({
  declared: "L2",
  measured: "unmeasured",
  advisory: true,
  note: "isolation is measured per run from the ledger, never here; this field is advisory, not enforced, and no sealing guarantee is claimed",
  failure: null,
});

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
  isolation: AdvisoryIsolation;
  ok: boolean;
  problems: string[];
  warnings: string[];
}

/** Runs `cmd args` with PATH taken from `env`; any failure means "not usable". */
function probe(cmd: string, args: string[], env: NodeJS.ProcessEnv): ToolProbe {
  const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", env });
  if (result.error || result.status !== 0) return { found: false, version: null };
  const first = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n")[0] ?? "";
  return { found: true, version: first.length > 0 ? first : null };
}

/**
 * Agent CLIs write caches under their home even for `--version`, so they are probed with a throwaway
 * home that is removed afterwards (spec §11 rule 1). Docker keeps the caller's environment so its
 * context and daemon settings still apply. The scratch dir goes under the caller's TMPDIR when that is
 * an absolute path, so a caller can keep it private; `os.tmpdir()` reads process.env, not `env`.
 */
function probeAgentCli(cmd: string, env: NodeJS.ProcessEnv): ToolProbe {
  const root = env.TMPDIR !== undefined && isAbsolute(env.TMPDIR) ? env.TMPDIR : tmpdir();
  const scratch = mkdtempSync(join(root, "omf-probe-"));
  try {
    // The real codex warns on stderr when CODEX_HOME does not exist yet.
    mkdirSync(join(scratch, "codex"));
    return probe(cmd, ["--version"], {
      ...env,
      HOME: scratch,
      CODEX_HOME: join(scratch, "codex"),
      CLAUDE_CONFIG_DIR: join(scratch, "claude"),
      XDG_CONFIG_HOME: join(scratch, "xdg-config"),
      XDG_CACHE_HOME: join(scratch, "xdg-cache"),
      XDG_DATA_HOME: join(scratch, "xdg-data"),
      XDG_STATE_HOME: join(scratch, "xdg-state"),
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function runDoctor(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
  probeIsolation: IsolationProbe = unmeasuredProbe,
): PreflightReport {
  const problems: string[] = [];

  const git = probe("git", ["--version"], env);
  const docker = probe("docker", ["--version"], env);
  const daemon = docker.found ? probe("docker", ["info", "--format", "{{.ServerVersion}}"], env).found : false;
  const claude = probeAgentCli("claude", env);
  const codex = probeAgentCli("codex", env);
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

  const warnings: string[] = [];
  let dir: string | null = null;
  let initialized = false;
  let ledgerResult: VerifyResult | null = null;
  let treeClean = true;
  if (toplevel !== null) {
    let location: ProjectLocation | null = null;
    try {
      location = locateProject(toplevel, env);
    } catch (err) {
      problems.push((err as Error).message);
    }
    if (location !== null) {
      dir = location.dir;
      try {
        assertStateTreeClean(location, env);
      } catch (err) {
        if (!(err instanceof SymlinkRefusedError)) throw err;
        // The state is not read through a link, so the report shows the project as not initialized.
        problems.push(err.message);
        treeClean = false;
      }
      if (treeClean) {
        const status = readProjectStatus(location);
        initialized = status.initialized;
        ledgerResult = status.ledger;
        const problem = projectProblem(status);
        if (problem !== null) problems.push(problem);
        if (status.ledger?.ok && status.ledger.tornTail) warnings.push(TORN_TAIL_WARNING);
        // Poka-yoke (spec §11 rule 4): sealed material in the repository or a worktree is a problem to fix before any run.
        if (status.initialized) {
          const sealed = sealedProblem(location, env);
          if (sealed !== null) problems.push(sealed);
        }
      }
    }
  }

  const reported: PreflightReport["tools"] = { git, docker: { ...docker, daemon }, claude, codex };
  const report: PreflightReport = {
    schema_version: 1,
    generated_at: now().toISOString(),
    tools: reported,
    repo: { is_git_repo: toplevel !== null, toplevel },
    project: { initialized, dir, ledger: ledgerResult },
    isolation: probeIsolation(env, reported),
    ok: problems.length === 0,
    problems,
    warnings,
  };
  // Never when the tree has a link: a linked state directory would take the temp file and the rename somewhere else.
  if (initialized && treeClean && dir !== null) {
    // Temp file plus rename: a concurrent reader sees the old report or the new one, and the mode is 0600 even over a 0644 file.
    writePrivateFileAtomic(join(dir, "preflight.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}
