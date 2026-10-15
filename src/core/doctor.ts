import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
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
  /** True when warnings were promoted to problems (`--strict`). */
  strict: boolean;
  /** `problems` with a one-line fix each, in the same order. */
  problem_details: Finding[];
  /** `warnings` with a one-line fix each and the stages that need the tool, in the same order. */
  warning_details: Finding[];
}

/** One thing doctor noticed. `needed_by` names the stages that need a missing tool; it is empty for other findings. */
export interface Finding {
  message: string;
  fix: string;
  needed_by: string[];
}

/** The probe is advisory: one that throws is reported as unmeasurable with its error text and never stops the report. */
function safeIsolation(
  probeIsolation: IsolationProbe,
  env: NodeJS.ProcessEnv,
  tools: PreflightReport["tools"],
): AdvisoryIsolation {
  try {
    return probeIsolation(env, tools);
  } catch (error) {
    const base = unmeasuredProbe(env, tools);
    return { ...base, measured: "unmeasurable", failure: error instanceof Error ? error.message : String(error) };
  }
}

/** One probe may not hold the report longer than this; a hung CLI counts as not usable. */
export const PROBE_TIMEOUT_MS = 5000;

/** The stages that need a tool OMF can run without. Their absence is a warning, not a problem. */
const NEEDED_BY = {
  docker: ["container judging", "metric runs in a container"],
  claude: ["the implementer", "the sealing author"],
  codex: ["the implementer", "the sealing author"],
} as const;

/** Runs `cmd args` with PATH taken from `env`; any failure means "not usable". */
function probe(cmd: string, args: string[], env: NodeJS.ProcessEnv): ToolProbe {
  const result = spawnSync(cmd, args, { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, killSignal: "SIGKILL", env });
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
  const scratch = makeProbeHome(env);
  try {
    return probe(cmd, ["--version"], probeHomeEnv(env, scratch));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function makeProbeHome(env: NodeJS.ProcessEnv): string {
  const root = env.TMPDIR !== undefined && isAbsolute(env.TMPDIR) ? env.TMPDIR : tmpdir();
  const scratch = mkdtempSync(join(root, "omf-probe-"));
  // The real codex warns on stderr when CODEX_HOME does not exist yet.
  mkdirSync(join(scratch, "codex"));
  return scratch;
}

function probeHomeEnv(env: NodeJS.ProcessEnv, scratch: string): NodeJS.ProcessEnv {
  return {
    ...env,
    HOME: scratch,
    CODEX_HOME: join(scratch, "codex"),
    CLAUDE_CONFIG_DIR: join(scratch, "claude"),
    XDG_CONFIG_HOME: join(scratch, "xdg-config"),
    XDG_CACHE_HOME: join(scratch, "xdg-cache"),
    XDG_DATA_HOME: join(scratch, "xdg-data"),
    XDG_STATE_HOME: join(scratch, "xdg-state"),
  };
}

/** The asynchronous twin of `probe`, so several probes can run at once. */
function probeAsync(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<ToolProbe> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, killSignal: "SIGKILL", env },
      (error, stdout, stderr) => {
        if (error) return resolve({ found: false, version: null });
        const first = `${stdout}${stderr}`.trim().split("\n")[0] ?? "";
        resolve({ found: true, version: first.length > 0 ? first : null });
      },
    );
  });
}

async function probeAgentCliAsync(cmd: string, env: NodeJS.ProcessEnv): Promise<ToolProbe> {
  const scratch = makeProbeHome(env);
  try {
    return await probeAsync(cmd, ["--version"], probeHomeEnv(env, scratch));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

interface Probes {
  git: ToolProbe;
  docker: ToolProbe;
  daemon: boolean;
  claude: ToolProbe;
  codex: ToolProbe;
}

function probeAllSequentially(env: NodeJS.ProcessEnv): Probes {
  const git = probe("git", ["--version"], env);
  const docker = probe("docker", ["--version"], env);
  const daemon = docker.found ? probe("docker", ["info", "--format", "{{.ServerVersion}}"], env).found : false;
  return { git, docker, daemon, claude: probeAgentCli("claude", env), codex: probeAgentCli("codex", env) };
}

/** All five probes at once, so the slowest one decides how long doctor takes. */
async function probeAllInParallel(env: NodeJS.ProcessEnv): Promise<Probes> {
  const [git, docker, daemonProbe, claude, codex] = await Promise.all([
    probeAsync("git", ["--version"], env),
    probeAsync("docker", ["--version"], env),
    probeAsync("docker", ["info", "--format", "{{.ServerVersion}}"], env),
    probeAgentCliAsync("claude", env),
    probeAgentCliAsync("codex", env),
  ]);
  // A reachable daemon implies the docker client exists; the client check still decides "found".
  return { git, docker, daemon: docker.found && daemonProbe.found, claude, codex };
}

export interface DoctorOptions {
  /** Promote the missing-tool warnings (a missing or unreachable Docker, a missing agent CLI) to problems; a torn ledger tail stays a warning. */
  strict?: boolean;
}

/** Sequential probes. Tests and library callers use this; the CLI uses `runDoctorParallel`. */
export function runDoctor(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
  probeIsolation: IsolationProbe = unmeasuredProbe,
  options: DoctorOptions = {},
): PreflightReport {
  return buildReport(cwd, env, now, probeIsolation, options, probeAllSequentially(env));
}

/** Same report as `runDoctor`, with the tool probes run in parallel. */
export async function runDoctorParallel(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
  probeIsolation: IsolationProbe = unmeasuredProbe,
  options: DoctorOptions = {},
): Promise<PreflightReport> {
  return buildReport(cwd, env, now, probeIsolation, options, await probeAllInParallel(env));
}

const LEDGER_FIX = "do not edit the ledger; restore it from a backup; details: omf ledger verify --json";

function buildReport(
  cwd: string,
  env: NodeJS.ProcessEnv,
  now: () => Date,
  probeIsolation: IsolationProbe,
  options: DoctorOptions,
  probes: Probes,
): PreflightReport {
  // One list in report order, so `--strict` can promote a warning without moving it: tools first, then the project.
  const ordered: Array<{ finding: Finding; kind: "problem" | "tool" | "notice" }> = [];
  const problem = (message: string, fix: string): void => {
    ordered.push({ finding: { message, fix, needed_by: [] }, kind: "problem" });
  };
  const warn = (message: string, fix: string, neededBy: readonly string[], kind: "tool" | "notice" = "tool"): void => {
    ordered.push({ finding: { message, fix, needed_by: [...neededBy] }, kind });
  };

  const { git, docker, daemon, claude, codex } = probes;
  if (!git.found) problem("git not found on PATH", "install git and make sure it is on PATH");
  if (!docker.found) {
    warn(
      "docker not found on PATH",
      "install Docker to run metrics and judging in a container; metrics can use --runner host meanwhile",
      NEEDED_BY.docker,
    );
  }
  for (const [name, tool] of [
    ["claude", claude],
    ["codex", codex],
  ] as const) {
    if (!tool.found) {
      warn(
        `${name} not found on PATH`,
        `install the ${name} CLI and make sure \`${name}\` is on PATH`,
        NEEDED_BY[name],
      );
    }
  }
  if (docker.found && !daemon) {
    warn(
      "docker daemon is not reachable",
      "start Docker (for example Docker Desktop) and check it with: docker info",
      NEEDED_BY.docker,
    );
  }

  let toplevel: string | null = null;
  try {
    toplevel = repoToplevel(cwd);
  } catch (err) {
    if (err instanceof UnsupportedRepoError) {
      problem(err.message, "run omf from a repository with a regular working tree (not a bare repository)");
    } else if (err instanceof NotAGitRepoError) {
      problem("not inside a git repository", "run omf from inside a git repository, or create one with: git init");
    } else {
      throw err;
    }
  }

  let dir: string | null = null;
  let initialized = false;
  let ledgerResult: VerifyResult | null = null;
  let treeClean = true;
  if (toplevel !== null) {
    let location: ProjectLocation | null = null;
    try {
      location = locateProject(toplevel, env);
    } catch (err) {
      problem((err as Error).message, "set OMF_HOME to an absolute path outside the repository, or unset it");
    }
    if (location !== null) {
      dir = location.dir;
      try {
        assertStateTreeClean(location, env);
      } catch (err) {
        if (!(err instanceof SymlinkRefusedError)) throw err;
        // The state is not read through a link, so the report shows the project as not initialized.
        problem(err.message, "remove the symbolic link from OMF state, or point OMF_HOME at a directory without links");
        treeClean = false;
      }
      if (treeClean) {
        const status = readProjectStatus(location);
        initialized = status.initialized;
        ledgerResult = status.ledger;
        const found = projectProblem(status);
        if (found !== null) {
          problem(found, status.ledger !== null && !status.ledger.ok ? LEDGER_FIX : "run omf init");
        }
        if (status.ledger?.ok && status.ledger.tornTail) {
          // A torn tail never failed doctor before warnings existed, so `--strict` leaves it a warning.
          warn(
            TORN_TAIL_WARNING,
            "run any command that writes to the ledger; the next write repairs the tail, or restore a backup",
            [],
            "notice",
          );
        }
        // Poka-yoke (spec §11 rule 4): vault material in the repository or a worktree is a problem to fix before any run.
        if (status.initialized) {
          const vaultProblem = sealedProblem(location, env);
          if (vaultProblem !== null) {
            problem(
              vaultProblem,
              "move the listed vault files out of the repository and the OMF worktrees, then run omf doctor again",
            );
          }
        }
      }
    }
  }

  const strict = options.strict === true;
  const promoted = (entry: (typeof ordered)[number]): boolean =>
    entry.kind === "problem" || (strict && entry.kind === "tool");
  const problemList = ordered.filter(promoted).map((entry) => entry.finding);
  const warningList = ordered.filter((entry) => !promoted(entry)).map((entry) => entry.finding);
  const reported: PreflightReport["tools"] = { git, docker: { ...docker, daemon }, claude, codex };
  const report: PreflightReport = {
    schema_version: 1,
    generated_at: now().toISOString(),
    tools: reported,
    repo: { is_git_repo: toplevel !== null, toplevel },
    project: { initialized, dir, ledger: ledgerResult },
    isolation: safeIsolation(probeIsolation, env, reported),
    ok: problemList.length === 0,
    problems: problemList.map((finding) => finding.message),
    warnings: warningList.map((finding) => finding.message),
    strict,
    problem_details: problemList,
    warning_details: warningList,
  };
  // Never when the tree has a link: a linked state directory would take the temp file and the rename somewhere else.
  if (initialized && treeClean && dir !== null) {
    // Temp file plus rename: a concurrent reader sees the old report or the new one, and the mode is 0600 even over a 0644 file.
    writePrivateFileAtomic(join(dir, "preflight.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}
