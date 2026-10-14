import { type Dirent, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { CANARY_SEARCH } from "../scenario/types.js";

/**
 * Poka-yoke (M3c rule 4, spec §8): OMF refuses to run while sealed material sits where the implementer can
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
    super(`refusing to run: sealed material inside the repository or an OMF worktree (${findings.length} finding(s))`);
    this.name = "PokaYokeError";
  }
}

export interface PokaYokeScope {
  repo: string;
  worktrees: readonly string[];
}

export interface ScanOptions {
  stateRoot: string;
  /** Default 300_000 entries across the repository and every worktree. */
  maxEntries?: number;
  /** Default 1 MiB; a larger regular file is not read. */
  maxFileBytes?: number;
  knownCanaries?: ReadonlySet<string>;
}

/** A canary-shaped string found in a worktree. Data, not a refusal (M3c-D13): `known` = it is one of this vault's canaries. */
export interface CanaryHit {
  worktree: string;
  path: string;
  known: boolean;
}

export interface ScanResult {
  findings: PokaYokeFinding[];
  canary_hits: CanaryHit[];
}

const DEFAULT_MAX_ENTRIES = 300_000;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

/** Fixed dependency and cache directories, skipped at any depth. Nothing else is skipped. */
const SKIP_NAMES: ReadonlySet<string> = new Set([".git", "node_modules", ".venv", "venv", "__pycache__"]);
const VAULT_DIRS: ReadonlySet<string> = new Set(["scenarios", "metrics"]);
const LEDGER_FILES: ReadonlySet<string> = new Set(["claim.lock", "item.lock", "approve.lock", "seal.lock", "ledger.lock", "ledger.jsonl"]);
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
    maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
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
 *    (`metric_lock`); claim.lock, item.lock, approve.lock, seal.lock (the seal stage's lock, Task 10), ledger.lock, ledger.jsonl (`ledger_or_lock_file`);
 *  - repository scope only: a regular file of at most maxFileBytes containing a canary (`canary`);
 *  - a symlink into the state root: always in the repository; in a worktree only when it also leaves that worktree;
 *  - ELOOP or any other read error, and more than maxEntries entries (`scan_incomplete`).
 * Worktree canary matches are not findings: they come back in `canary_hits`.
 */
export function scanForSealed(scope: PokaYokeScope, options: ScanOptions): ScanResult {
  return scanScope(scope, options);
}
