import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { sha256Hex } from "./canonical-json.js";

export class NotAGitRepoError extends Error {
  constructor(readonly cwd: string) {
    super(`not a git repository: ${cwd}`);
    this.name = "NotAGitRepoError";
  }
}

export class UnsupportedRepoError extends Error {
  constructor(
    readonly cwd: string,
    reason: string,
  ) {
    super(`unsupported repository at ${cwd}: ${reason}`);
    this.name = "UnsupportedRepoError";
  }
}

/**
 * Environment for git children: GIT_* variables are dropped so an inherited GIT_DIR cannot redirect git,
 * and the C locale is forced so git's messages are parseable.
 */
export function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const filtered = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_")));
  return { ...filtered, LC_ALL: "C" };
}

/** Root of all OMF host state. Must be absolute; never inside the user's repository. */
export function omfHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OMF_HOME;
  if (explicit !== undefined && explicit !== "") {
    if (!isAbsolute(explicit)) throw new Error(`OMF_HOME must be an absolute path: ${explicit}`);
    return explicit;
  }
  const home = env.HOME !== undefined && env.HOME !== "" ? env.HOME : homedir();
  if (!isAbsolute(home)) throw new Error(`HOME must be an absolute path: ${home}`);
  return join(home, ".omf");
}

function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: gitEnv() });
  } catch (err) {
    const failure = err as NodeJS.ErrnoException & { status?: number | null; stderr?: string };
    const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
    if (failure.status === 128 && /not a git repository/i.test(stderr)) throw new NotAGitRepoError(cwd);
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr.trim() || failure.message}`);
  }
}

/**
 * Root of the repository's main working tree. Every linked worktree of the same repository
 * (including OMF's own candidate worktrees) resolves to the same root, so they share one project.
 */
export function repoToplevel(cwd: string): string {
  if (!existsSync(cwd)) throw new Error(`directory does not exist: ${cwd}`);
  const listing = git(["worktree", "list", "--porcelain"], cwd);
  const mainEntry = (listing.split("\n\n")[0] ?? "").split("\n");
  if (mainEntry.includes("bare")) throw new UnsupportedRepoError(cwd, "bare repositories are not supported");
  const worktreeLine = mainEntry.find((line) => line.startsWith("worktree "));
  if (worktreeLine === undefined) throw new Error(`unexpected 'git worktree list' output in ${cwd}`);
  return realpathSync.native(worktreeLine.slice("worktree ".length));
}

/** First 16 hex characters of the SHA-256 of a repository root's real path. */
export function projectId(toplevel: string): string {
  return sha256Hex(realpathSync.native(toplevel)).slice(0, 16);
}

/** Real path of `path`, resolving symlinks in its nearest existing ancestor (the rest may not exist yet). */
function realpathOfNearestExisting(path: string): string {
  let current = resolve(path);
  const rest: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    rest.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync.native(current), ...rest);
}

/** True when `dir` is `root` or inside it. Both sides are compared by real path, so symlinks cannot hide an overlap. */
function isWithin(dir: string, root: string): boolean {
  const rel = relative(realpathOfNearestExisting(root), realpathOfNearestExisting(dir));
  const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  return rel === "" || !outside;
}

/** Throws when `dir` is the repository root or inside it (spec §11 rule 1). Compares real paths. */
export function assertOutsideRepo(dir: string, repo: string): void {
  if (isWithin(dir, repo)) {
    throw new Error(`OMF state must live outside the repository: ${dir} (set OMF_HOME to a directory outside ${repo})`);
  }
}

/**
 * Throws when `dir` is inside a config home that the agent CLIs own: ~/.claude, ~/.codex, and
 * CLAUDE_CONFIG_DIR / CODEX_HOME when they are set to absolute paths (spec §11 rule 1).
 */
export function assertOutsideAgentHomes(dir: string, env: NodeJS.ProcessEnv = process.env): void {
  const home = env.HOME !== undefined && env.HOME !== "" ? env.HOME : homedir();
  const roots = [join(home, ".claude"), join(home, ".codex")];
  for (const key of ["CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const) {
    const value = env[key];
    if (value !== undefined && value !== "" && isAbsolute(value)) roots.push(value);
  }
  for (const root of roots) {
    if (isWithin(dir, root)) throw new Error(`OMF state must not live inside ${root} (spec §11 rule 1): ${dir}`);
  }
}

/** Where a repository's host state lives. The only place that derives it. */
export interface ProjectLocation {
  repo: string;
  id: string;
  dir: string;
}

/** Location for a repository root (already resolved by `repoToplevel`). Throws when it would sit in the repo or an agent home. */
export function locateProject(repo: string, env: NodeJS.ProcessEnv = process.env): ProjectLocation {
  const id = projectId(repo);
  const dir = join(omfHome(env), "projects", id);
  assertOutsideRepo(dir, repo);
  assertOutsideAgentHomes(dir, env);
  return { repo, id, dir };
}

/** Location of the project that `cwd` belongs to. */
export function resolveProject(cwd: string, env: NodeJS.ProcessEnv = process.env): ProjectLocation {
  return locateProject(repoToplevel(cwd), env);
}

export function projectDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolveProject(cwd, env).dir;
}
