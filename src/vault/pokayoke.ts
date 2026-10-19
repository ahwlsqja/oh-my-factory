import { type Dirent, type Stats, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { ProjectLocation } from "../core/paths.js";
import { realProjectDir, stateRoot } from "../core/safe-fs.js";
import { CANARY_SEARCH } from "../scenario/types.js";

/**
 * Poka-yoke (spec §11 rule 4, §8): OMF refuses to run while sealed material sits where the implementer can
 * read it, in the repository or in an OMF worktree. The scan is a plain recursive lstat walk. It runs no git
 * command (a worktree may be hostile, and M3e's hardened git does not exist yet) and never follows a symlink.
 *
 * Known limit: this is a name and canary scan, not a proof. A renamed copy of a scenario with its canary
 * edited out is not found.
 */

export type PokaYokeKind =
  | "vault_path"
  | "metric_lock"
  | "ledger_or_lock_file"
  | "canary"
  | "symlink_into_state"
  | "scan_incomplete";

/** `path` is relative to the repository root, or (worktree scope) starts with the worktree's directory name. Never file content. */
export interface PokaYokeFinding {
  kind: PokaYokeKind;
  where: "repo" | "worktree";
  path: string;
}

export class PokaYokeError extends Error {
  constructor(readonly findings: readonly PokaYokeFinding[]) {
    super(
      `refusing to run: sealed material inside the repository or an OMF worktree (${findings.length} finding(s)); run \`omf doctor\` to list them`,
    );
    this.name = "PokaYokeError";
  }
}

export interface PokaYokeScope {
  repo: string;
  worktrees: readonly string[];
}

export interface ScanOptions {
  stateRoot: string;
  /** Default DEFAULT_MAX_SCAN_ENTRIES entries across the repository and every worktree. */
  maxEntries?: number;
  /** Default 1 MiB; a larger regular file is not read. */
  maxFileBytes?: number;
  knownCanaries?: ReadonlySet<string>;
}

/** A canary-shaped string found in a worktree. Data, not a refusal: `known` = it is one of this vault's canaries. */
export interface CanaryHit {
  worktree: string;
  path: string;
  known: boolean;
}

export interface ScanResult {
  findings: PokaYokeFinding[];
  canary_hits: CanaryHit[];
}

/**
 * Entries (files, directories, links) the scan visits across the repository and every worktree before it gives up
 * and reports `scan_incomplete`. Directories named in SKIP_NAMES count as one entry and are not descended into.
 * One million covers a checkout with several hundred thousand untracked or ignored entries (build output,
 * caches) while a runaway tree still stops the scan. Reaching the cap blocks; it never passes.
 */
export const DEFAULT_MAX_SCAN_ENTRIES = 1_000_000;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

/** Fixed dependency and cache directories, skipped at any depth. Nothing else is skipped. */
const SKIP_NAMES: ReadonlySet<string> = new Set([".git", "node_modules", ".venv", "venv", "__pycache__"]);
const VAULT_DIRS: ReadonlySet<string> = new Set(["scenarios", "metrics"]);
const LEDGER_FILES: ReadonlySet<string> = new Set([
  "claim.lock",
  "item.lock",
  "approve.lock",
  "seal.lock",
  "ledger.lock",
  "ledger.jsonl",
]);
/** Mirrors METRIC_ID_PATTERN in src/goal/goal-file.ts; a metric lock is named `${metricId}.lock.json` (src/goal/metrics.ts). */
const METRIC_LOCK = /^m-[a-z0-9]+(-[a-z0-9]+)*\.lock\.json$/;
/** Global twin of CANARY_SEARCH, for collecting every canary in a worktree file. */
const CANARY_ALL = new RegExp(CANARY_SEARCH.source, "g");

function lockKindOf(name: string): PokaYokeKind | null {
  if (name === "goal.lock.json" || METRIC_LOCK.test(name)) return "metric_lock";
  if (LEDGER_FILES.has(name)) return "ledger_or_lock_file";
  return null;
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

interface Limits {
  stateRoot: string;
  maxEntries: number;
  maxFileBytes: number;
  known: ReadonlySet<string>;
}

/** Walks one root. Returns false when the shared entry budget ran out, so the caller stops walking. */
function scanRoot(
  root: string,
  where: PokaYokeFinding["where"],
  label: string | null,
  limits: Limits,
  counter: { entries: number },
  out: ScanResult,
): boolean {
  const shown = (rel: string): string => {
    const own = rel === "" ? "." : rel;
    return label === null ? own : join(label, own);
  };
  const add = (kind: PokaYokeKind, rel: string): void => {
    out.findings.push({ kind, where, path: shown(rel) });
  };

  let ownRoot: string;
  try {
    ownRoot = realpathSync.native(root);
  } catch {
    add("scan_incomplete", "");
    return true;
  }

  const pending: string[] = [""];
  for (let relDir = pending.pop(); relDir !== undefined; relDir = pending.pop()) {
    let items: Dirent[];
    try {
      items = readdirSync(join(root, relDir), { withFileTypes: true });
    } catch {
      add("scan_incomplete", relDir);
      continue;
    }
    for (const item of items) {
      counter.entries += 1;
      if (counter.entries > limits.maxEntries) {
        add("scan_incomplete", relDir);
        return false;
      }
      if (SKIP_NAMES.has(item.name)) continue;
      const rel = relDir === "" ? item.name : join(relDir, item.name);
      const path = join(root, rel);

      if (VAULT_DIRS.has(item.name) && basename(relDir) === "vault") {
        add("vault_path", rel);
        continue;
      }
      if (item.isSymbolicLink()) {
        let real: string;
        try {
          real = realpathSync.native(path);
        } catch {
          add("scan_incomplete", rel); // ELOOP, a dangling link, or a permission error
          continue;
        }
        // A worktree lives under the state root, so a link that stays inside its own worktree is normal.
        if (isInside(real, limits.stateRoot) && (where === "repo" || !isInside(real, ownRoot))) {
          add("symlink_into_state", rel);
        }
        continue;
      }
      if (item.isDirectory()) {
        pending.push(rel);
        continue;
      }
      if (!item.isFile()) continue;

      const lockKind = lockKindOf(item.name);
      if (lockKind !== null) {
        add(lockKind, rel);
        continue;
      }
      let text: string;
      try {
        if (lstatSync(path).size > limits.maxFileBytes) continue;
        text = readFileSync(path).toString("latin1");
      } catch {
        add("scan_incomplete", rel);
        continue;
      }
      if (where === "repo") {
        if (CANARY_SEARCH.test(text)) add("canary", rel);
        continue;
      }
      const seen = new Set<string>();
      for (const match of text.matchAll(CANARY_ALL)) {
        if (seen.has(match[0])) continue;
        seen.add(match[0]);
        out.canary_hits.push({ worktree: label ?? "", path: rel, known: limits.known.has(match[0]) });
      }
    }
  }
  return true;
}

/** `repo` null scans the worktrees only (scanWorktreeCanaries). */
function scanScope(scope: { repo: string | null; worktrees: readonly string[] }, options: ScanOptions): ScanResult {
  const limits: Limits = {
    stateRoot: options.stateRoot,
    maxEntries: options.maxEntries ?? DEFAULT_MAX_SCAN_ENTRIES,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    known: options.knownCanaries ?? new Set<string>(),
  };
  const counter = { entries: 0 };
  const out: ScanResult = { findings: [], canary_hits: [] };
  if (scope.repo !== null && !scanRoot(scope.repo, "repo", null, limits, counter, out)) return out;
  for (const worktree of scope.worktrees) {
    if (!scanRoot(worktree, "worktree", basename(worktree), limits, counter, out)) break;
  }
  return out;
}

/**
 * Findings (these refuse):
 *  - an entry named vault/scenarios or vault/metrics (not descended into); goal.lock.json or m-<id>.lock.json
 *    (`metric_lock`); claim.lock, item.lock, approve.lock, seal.lock (the seal stage's lock), ledger.lock, ledger.jsonl (`ledger_or_lock_file`);
 *  - repository scope only: a regular file of at most maxFileBytes containing a canary (`canary`);
 *  - a symlink into the state root: always in the repository; in a worktree only when it also leaves that worktree;
 *  - ELOOP or any other read error, and more than maxEntries entries (`scan_incomplete`).
 * Worktree canary matches are not findings: they come back in `canary_hits`.
 */
export function scanForSealed(scope: PokaYokeScope, options: ScanOptions): ScanResult {
  return scanScope(scope, options);
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

interface WorktreeLayout {
  /** Real directories under <projectDir>/worktrees, sorted. */
  dirs: string[];
  /** Entries that are symlinks (or "." when worktrees/ itself is one): each is a finding, and none is scanned. */
  links: string[];
  /** worktrees/ exists but could not be listed: nothing under it was looked at, so the scan is incomplete. */
  unreadable: boolean;
}

/**
 * The project's worktrees, read with lstat. The state-tree guard skips worktrees/ (links inside a working
 * tree are normal), so a link standing in for a worktree, or for worktrees/ itself, is caught here.
 */
function worktreeLayout(location: ProjectLocation, env: NodeJS.ProcessEnv): WorktreeLayout {
  const base = join(realProjectDir(location, env).dir, "worktrees");
  let stat: Stats | null;
  try {
    stat = lstatOrNull(base);
  } catch {
    return { dirs: [], links: [], unreadable: true };
  }
  if (stat === null) return { dirs: [], links: [], unreadable: false };
  if (stat.isSymbolicLink()) return { dirs: [], links: ["."], unreadable: false };
  const dirs: string[] = [];
  const links: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return { dirs: [], links: [], unreadable: true };
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) links.push(entry.name);
    else if (entry.isDirectory()) dirs.push(join(base, entry.name));
  }
  return { dirs: dirs.sort(), links: links.sort(), unreadable: false };
}

/** repo = location.repo; worktrees = the real directories under <projectDir>/worktrees. */
export function pokaYokeScopeFor(location: ProjectLocation, env: NodeJS.ProcessEnv = process.env): PokaYokeScope {
  return { repo: location.repo, worktrees: worktreeLayout(location, env).dirs };
}

function fullScan(location: ProjectLocation, env: NodeJS.ProcessEnv): ScanResult {
  const layout = worktreeLayout(location, env);
  const result = scanForSealed({ repo: location.repo, worktrees: layout.dirs }, { stateRoot: stateRoot(env) });
  for (const name of layout.links) result.findings.push({ kind: "symlink_into_state", where: "worktree", path: name });
  if (layout.unreadable) result.findings.push({ kind: "scan_incomplete", where: "worktree", path: "worktrees" });
  return result;
}

/**
 * Throws PokaYokeError when the repository or an OMF worktree holds sealed material or could not be scanned
 * completely. Canary hits in worktrees are data and never throw. Called by runSealStage, runGate2, the decide
 * actions and the sequencer before every station.
 */
export function assertNoSealedInRepo(location: ProjectLocation, env: NodeJS.ProcessEnv = process.env): void {
  const { findings } = fullScan(location, env);
  if (findings.length > 0) throw new PokaYokeError(findings);
}

/**
 * Canary-shaped strings in the project's worktrees, with `known` set from `knownCanaries` (the verified vault
 * canaries, `listVaultCanaries`). For M3e's S5 audit and GATE-3. A scan that could not see everything throws:
 * a canary audit that silently skips a path would fail open.
 */
export function scanWorktreeCanaries(
  location: ProjectLocation,
  knownCanaries: ReadonlySet<string>,
  env: NodeJS.ProcessEnv = process.env,
): CanaryHit[] {
  const layout = worktreeLayout(location, env);
  const out = scanScope({ repo: null, worktrees: layout.dirs }, { stateRoot: stateRoot(env), knownCanaries });
  const incomplete = out.findings.filter((finding) => finding.kind === "scan_incomplete");
  if (layout.unreadable) incomplete.push({ kind: "scan_incomplete", where: "worktree", path: "worktrees" });
  if (incomplete.length > 0) throw new PokaYokeError(incomplete);
  return out.canary_hits;
}

const PROBLEM_PREFIX = "sealed material inside the repository or an OMF worktree";
const PROBLEM_LISTED = 5;

const VAULT_FIX = "move the listed vault files out of the repository and the OMF worktrees, then run omf doctor again";
const CANARY_FIX =
  "a canary-shaped string sits in an ordinary file, such as a test fixture or a documentation example; do not move source or tests into the vault. Build such a value at run time, or use a placeholder that does not match the pattern, then run omf doctor again. If the string is a genuine sealed canary that reached a committed file, the scenarios are exposed: remove it and treat the sealed set as burned (re-author and re-seal), because editing the working tree leaves the value in git history";

/** The `omf doctor` problem line and its fix for this project, or null when the scan is clean. Paths only. */
export function sealedReport(
  location: ProjectLocation,
  env: NodeJS.ProcessEnv = process.env,
): { problem: string; fix: string } | null {
  const { findings } = fullScan(location, env);
  if (findings.length === 0) return null;
  const listed = findings
    .slice(0, PROBLEM_LISTED)
    .map((finding) => `${finding.kind}: ${finding.path}`)
    .join(", ");
  const more = findings.length > PROBLEM_LISTED ? ", ..." : "";
  const hasCanary = findings.some((finding) => finding.kind === "canary");
  const hasOther = findings.some((finding) => finding.kind !== "canary");
  const fix = hasCanary ? (hasOther ? `${VAULT_FIX}; for a canary finding, ${CANARY_FIX}` : CANARY_FIX) : VAULT_FIX;
  return { problem: `${PROBLEM_PREFIX}: ${findings.length} finding(s) (${listed}${more})`, fix };
}

/** The `omf doctor` problem line for this project, or null when the scan is clean. Paths only. */
export function sealedProblem(location: ProjectLocation, env: NodeJS.ProcessEnv = process.env): string | null {
  return sealedReport(location, env)?.problem ?? null;
}
