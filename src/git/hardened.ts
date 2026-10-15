import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { assertOutsideAgentHomes, assertOutsideRepo } from "../core/paths.js";

/**
 * Flat argv prefix for every git call that touches data a container wrote. The order is fixed and tested byte for
 * byte. The prefix does not switch off `filter.*`, `diff.*.textconv` or `diff.external`: `checkTarget` refuses a repository whose
 * own config defines one (M3e review), and the diff calls pass `--no-ext-diff --no-textconv`. `protocol.file.allow=never` stays: a bundle is imported without the transport layer (`bundleVerify`,
 * `unbundle`, `fsckStrict`, M3e-D22), and no per-operation override exists.
 */
export const HARDENED_GIT_CONFIG: readonly string[] = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.untrackedCache=false",
  "core.attributesFile=/dev/null",
  "core.excludesFile=/dev/null",
  "core.pager=cat",
  "protocol.file.allow=never",
  "protocol.allow=never",
  "transfer.fsckObjects=true",
  "fetch.fsckObjects=true",
  "receive.fsckObjects=true",
  "gc.auto=0",
  "maintenance.auto=false",
].flatMap((setting) => ["-c", setting]);

/**
 * PATH only, taken from `base`; every `GIT_*` variable and everything else is dropped. The seven fixed variables switch
 * off system and global config, prompts, optional locks, system attributes and replace refs, and force the C locale.
 */
export function hardenedGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    LC_ALL: "C",
  };
  if (base.PATH !== undefined) env.PATH = base.PATH;
  return env;
}

export type HostGitErrorCode = "not_absolute" | "gitdir_invalid" | "git_failed" | "output_limit" | "timeout";

/**
 * The message is the code plus the exit status and nothing else: git's stderr names tree paths
 * (`error: patch failed: src/x.ts:12`), so it is dropped. A stderr excerpt lives in a non-enumerable `diagnostic`
 * field that no renderer, `JSON.stringify` or `String(error)` ever prints.
 */
export class HostGitError extends Error {
  readonly code: HostGitErrorCode;
  readonly exitStatus: number | null;
  declare readonly diagnostic: string;

  constructor(code: HostGitErrorCode, exitStatus: number | null = null, diagnostic = "") {
    super(exitStatus === null ? code : `${code} (exit ${exitStatus})`);
    this.name = "HostGitError";
    this.code = code;
    this.exitStatus = exitStatus;
    Object.defineProperty(this, "diagnostic", { value: diagnostic, enumerable: false });
  }
}

/** Always an explicit repository. A container-written `.git` is never discovered because discovery is never used. */
export interface GitTarget {
  /** Absolute; its last component is a real directory (not a symlink) holding a regular HEAD and an `objects/` directory. */
  gitDir: string;
  /** Absolute; only for apply and clean checks on a materialized copy. */
  workTree?: string;
  /** Absolute; a private temp index. Every `read-tree` call requires it, so the quarantine repository's own index is never written. */
  indexFile?: string;
}

export interface HostGitOptions {
  input?: Buffer | string;
  maxOutputBytes?: number;
  timeoutMs?: number;
  cwd?: string;
}

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

/**
 * Config the hardened prefix cannot neutralise. A `filter.*` driver runs on `checkout-index`, `archive` and `update-index`
 * for any tree whose `.gitattributes` names it, `diff.*.textconv`, `diff.*.command` and `diff.external` run on a diff, and an
 * include pulls in config this check never read. The config of a quarantine is written by OMF and never carries one, so a
 * repository that does is refused. (`core.fsmonitor` and `core.hooksPath` are not listed: `HARDENED_GIT_CONFIG` overrides them.)
 * The file is read as text, not through git, so the check needs no process and cannot be redirected by `PATH`.
 */
const SECTION = /^\s*\[\s*([A-Za-z0-9-]+)(?:\s+"(?:[^"\\]|\\.)*"|\.[^\s\]]*)?\s*\](.*)$/;
const KEY = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*(?:[=#;]|$)/;

function definesDriver(text: string): boolean {
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    const header = SECTION.exec(line);
    let rest = line;
    if (header !== null) {
      section = (header[1] ?? "").toLowerCase();
      if (section === "filter" || section === "include" || section === "includeif") return true;
      rest = header[2] ?? "";
    }
    const key = KEY.exec(rest)?.[1]?.toLowerCase();
    if (key === undefined || section !== "diff") continue;
    if (key === "textconv" || key === "command" || key === "external") return true;
  }
  return false;
}

/** Throws `gitdir_invalid` when the repository's own config (`config`, and `config.worktree` when it exists) defines a driver or an include. */
function assertNoDrivers(gitDir: string): void {
  for (const name of ["config", "config.worktree"]) {
    const file = join(gitDir, name);
    if (lstatSync(file, { throwIfNoEntry: false }) === undefined) continue;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      throw new HostGitError("gitdir_invalid");
    }
    if (definesDriver(text)) throw new HostGitError("gitdir_invalid");
  }
}

function checkTarget(target: GitTarget, args: readonly string[]): void {
  for (const value of [target.gitDir, target.workTree, target.indexFile]) {
    if (value !== undefined && !isAbsolute(value)) throw new HostGitError("not_absolute");
  }
  const dir = lstatSync(target.gitDir, { throwIfNoEntry: false });
  const head = lstatSync(join(target.gitDir, "HEAD"), { throwIfNoEntry: false });
  const objects = lstatSync(join(target.gitDir, "objects"), { throwIfNoEntry: false });
  if (dir === undefined || !dir.isDirectory() || head === undefined || !head.isFile() || objects === undefined || !objects.isDirectory()) {
    throw new HostGitError("gitdir_invalid");
  }
  assertNoDrivers(target.gitDir);
  // The first argument that is not an option names the subcommand.
  if (args.find((arg) => !arg.startsWith("-")) === "read-tree" && target.indexFile === undefined) throw new HostGitError("gitdir_invalid");
}

function spawnGit(argv: readonly string[], env: NodeJS.ProcessEnv, cwd: string, options: HostGitOptions): Promise<{ stdout: Buffer; stderr: string }> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...argv], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const fail = (error: HostGitError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };
    timer = setTimeout(() => fail(new HostGitError("timeout")), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxOutputBytes) fail(new HostGitError("output_limit"));
      else stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (errBytes < MAX_DIAGNOSTIC_BYTES) stderr.push(chunk);
      errBytes += chunk.length;
    });
    child.stdin?.on("error", () => {}); // EPIPE when git exits without reading its input; the exit status says what happened
    child.once("error", () => fail(new HostGitError("git_failed")));
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = Buffer.concat(stderr).toString("utf8");
      if (code === 0) resolve({ stdout: Buffer.concat(stdout), stderr: text });
      else reject(new HostGitError("git_failed", code, text));
    });
    child.stdin?.end(options.input);
  });
}

/**
 * argv = `[...HARDENED_GIT_CONFIG, --git-dir=<gitDir>, (--work-tree=<workTree>), ...args]`; defaults 64 MiB of output and 120 s.
 * env = `hardenedGitEnv()` (which drops every GIT_* variable, `GIT_INDEX_FILE` included), THEN `GIT_INDEX_FILE=<indexFile>` when
 * the target has one. cwd defaults to the work tree, else the git dir, never the caller's directory.
 */
export async function runHostGit(target: GitTarget, args: readonly string[], options: HostGitOptions = {}): Promise<{ stdout: Buffer; stderr: string }> {
  checkTarget(target, args);
  const argv = [
    ...HARDENED_GIT_CONFIG,
    `--git-dir=${target.gitDir}`,
    ...(target.workTree === undefined ? [] : [`--work-tree=${target.workTree}`]),
    ...args,
  ];
  const env = hardenedGitEnv();
  if (target.indexFile !== undefined) env.GIT_INDEX_FILE = target.indexFile;
  return spawnGit(argv, env, options.cwd ?? target.workTree ?? target.gitDir, options);
}

/**
 * `git init --bare --template=` (no sample hooks) inside a fresh 0700 directory under `parent`; returns the bare git
 * directory, `<fresh>/git`. For `git apply` contexts that have no repository of their own. `parent` is checked against
 * the agent config homes always, and against the user's repository when the caller passes it (M3e-D29).
 */
export async function createScratchGitDir(parent: string, repo?: string): Promise<string> {
  if (!isAbsolute(parent)) throw new HostGitError("not_absolute");
  assertOutsideAgentHomes(parent);
  if (repo !== undefined) assertOutsideRepo(parent, repo);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const holder = mkdtempSync(join(parent, "scratch-"));
  const gitDir = join(holder, "git");
  await spawnGit([...HARDENED_GIT_CONFIG, "init", "--bare", "--quiet", "--template=", gitDir], hardenedGitEnv(), holder, {});
  return gitDir;
}
