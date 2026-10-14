import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanForSealed } from "../../src/vault/pokayoke.js";
import { makeTempDir } from "../helpers/tmp.js";

/** Built at run time: a full canary literal in this file would trip OMF run on OMF. */
const canary = (): string => `omf-canary-${randomBytes(16).toString("hex")}`;

/** A temp dir under its real path, so a symlink's realpath compares equal to it (macOS /var -> /private/var). */
function realDir(prefix: string): string {
  return realpathSync.native(makeTempDir(prefix));
}

function put(root: string, rel: string, content = "x\n"): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

interface Row {
  kind: string;
  where: string;
  path: string;
}
const summary = (findings: readonly Row[]): string[] => findings.map((f) => `${f.where}:${f.kind}:${f.path}`).sort();

describe("scanForSealed: repository scope", () => {
  it("passes a clean tree", () => {
    const state = realDir("omf-state-");
    const repo = realDir("omf-repo-");
    put(repo, "src/a.ts");
    put(repo, "README.md");
    expect(scanForSealed({ repo, worktrees: [] }, { stateRoot: state })).toEqual({ findings: [], canary_hits: [] });
  });

  it("refuses vault/scenarios and vault/metrics without descending into them", () => {
    const state = realDir("omf-state-");
    const repo = realDir("omf-repo-");
    put(repo, "vault/scenarios/w-1/seal-1/s-1.yaml");
    put(repo, "vault/metrics/m-x.json");
    const result = scanForSealed({ repo, worktrees: [] }, { stateRoot: state });
    expect(summary(result.findings)).toEqual([
      `repo:vault_path:${join("vault", "metrics")}`,
      `repo:vault_path:${join("vault", "scenarios")}`,
    ]);
  });

  it("refuses lock and ledger files by name and metric locks by pattern, at any depth", () => {
    const state = realDir("omf-state-");
    const repo = realDir("omf-repo-");
    put(repo, "goal.lock.json");
    put(repo, "deep/m-latency.lock.json");
    for (const name of ["claim.lock", "item.lock", "approve.lock", "seal.lock", "ledger.lock", "ledger.jsonl"]) put(repo, name);
    put(repo, "m_bad.lock.json"); // underscore: not the metric-lock name pattern
    put(repo, "notes.lock"); // not a name OMF writes
    const result = scanForSealed({ repo, worktrees: [] }, { stateRoot: state });
    expect(summary(result.findings)).toEqual(
      [
        "repo:metric_lock:goal.lock.json",
        `repo:metric_lock:${join("deep", "m-latency.lock.json")}`,
        "repo:ledger_or_lock_file:claim.lock",
        "repo:ledger_or_lock_file:item.lock",
        "repo:ledger_or_lock_file:approve.lock",
        "repo:ledger_or_lock_file:seal.lock", // Task 10's seal-stage lock
        "repo:ledger_or_lock_file:ledger.lock",
        "repo:ledger_or_lock_file:ledger.jsonl",
      ].sort(),
    );
  });

  it("refuses a canary string in a regular file and reports only the path", () => {
    const state = realDir("omf-state-");
    const repo = realDir("omf-repo-");
    const value = canary();
    put(repo, "docs/notes.md", `see ${value} here\n`);
    const result = scanForSealed({ repo, worktrees: [] }, { stateRoot: state });
    expect(result.findings).toEqual([{ kind: "canary", where: "repo", path: join("docs", "notes.md") }]);
    expect(JSON.stringify(result)).not.toContain(value);
  });

  it("refuses a symlink whose real path is inside the state root", () => {
    const state = realDir("omf-state-");
    const repo = realDir("omf-repo-");
    symlinkSync(state, join(repo, "omf-home"));
    const result = scanForSealed({ repo, worktrees: [] }, { stateRoot: state });
    expect(result.findings).toEqual([{ kind: "symlink_into_state", where: "repo", path: "omf-home" }]);
  });

  it("skips the fixed dependency and cache directories and nothing else", () => {
    const state = realDir("omf-state-");
    const repo = realDir("omf-repo-");
    put(repo, "node_modules/pkg/ledger.jsonl", canary());
    put(repo, ".git/goal.lock.json", canary());
    put(repo, ".venv/claim.lock");
    put(repo, "venv/claim.lock");
    put(repo, "__pycache__/item.lock");
    expect(scanForSealed({ repo, worktrees: [] }, { stateRoot: state }).findings).toEqual([]);
    put(repo, "other/ledger.jsonl");
    expect(summary(scanForSealed({ repo, worktrees: [] }, { stateRoot: state }).findings)).toEqual([
      `repo:ledger_or_lock_file:${join("other", "ledger.jsonl")}`,
    ]);
  });

  it("does not read a file larger than maxFileBytes", () => {
    const state = realDir("omf-state-");
    const repo = realDir("omf-repo-");
    put(repo, "big.txt", `${canary()}${"x".repeat(200)}`);
    expect(scanForSealed({ repo, worktrees: [] }, { stateRoot: state, maxFileBytes: 100 }).findings).toEqual([]);
    put(repo, "small.txt", canary());
    expect(summary(scanForSealed({ repo, worktrees: [] }, { stateRoot: state, maxFileBytes: 100 }).findings)).toEqual([
      "repo:canary:small.txt",
    ]);
  });
});

describe("scanForSealed: worktree scope", () => {
  /** A worktree under the state root, as OMF creates them. */
  function worktree(state: string): string {
    const dir = join(state, "projects", "p1", "worktrees", "w-1");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("refuses vault paths and lock files, with the worktree name in the path", () => {
    const state = realDir("omf-state-");
    const repo = realDir("omf-repo-");
    const wt = worktree(state);
    put(wt, "vault/metrics/m-x.json");
    put(wt, "claim.lock");
    const result = scanForSealed({ repo, worktrees: [wt] }, { stateRoot: state });
    expect(summary(result.findings)).toEqual([
      "worktree:ledger_or_lock_file:w-1/claim.lock",
      `worktree:vault_path:${join("w-1", "vault", "metrics")}`,
    ]);
  });

  it("refuses a symlink that escapes its worktree into the state root, and allows one that stays inside", () => {
    const state = realDir("omf-state-");
    const repo = realDir("omf-repo-");
    const wt = worktree(state);
    put(wt, "docs/README.md");
    symlinkSync(join("docs", "README.md"), join(wt, "README.md"));
    expect(scanForSealed({ repo, worktrees: [wt] }, { stateRoot: state }).findings).toEqual([]);
    symlinkSync(join(state, "projects"), join(wt, "escape"));
    const result = scanForSealed({ repo, worktrees: [wt] }, { stateRoot: state });
    expect(summary(result.findings)).toEqual([`worktree:symlink_into_state:${join("w-1", "escape")}`]);
  });

  it("returns canary-shaped strings as data, with known set from the vault canaries, and never as a finding", () => {
    const state = realDir("omf-state-");
    const repo = realDir("omf-repo-");
    const wt = worktree(state);
    const known = canary();
    const madeUp = canary();
    put(wt, "notes.txt", `${known} then ${madeUp} then ${known} again\n`);
    const result = scanForSealed({ repo, worktrees: [wt] }, { stateRoot: state, knownCanaries: new Set([known]) });
    expect(result.findings).toEqual([]);
    expect(result.canary_hits).toEqual([
      { worktree: "w-1", path: "notes.txt", known: true },
      { worktree: "w-1", path: "notes.txt", known: false },
    ]);
  });
});

describe("scanForSealed: fail closed", () => {
  it("gives scan_incomplete for a symlink loop (ELOOP) instead of throwing", () => {
    const state = realDir("omf-state-");
    const repo = realDir("omf-repo-");
    symlinkSync("loop-b", join(repo, "loop-a"));
    symlinkSync("loop-a", join(repo, "loop-b"));
    const result = scanForSealed({ repo, worktrees: [] }, { stateRoot: state });
    expect(summary(result.findings)).toEqual(["repo:scan_incomplete:loop-a", "repo:scan_incomplete:loop-b"]);
  });

  it("gives scan_incomplete when the tree has more entries than maxEntries", () => {
    const state = realDir("omf-state-");
    const repo = realDir("omf-repo-");
    for (let i = 0; i < 10; i++) put(repo, `f${i}.txt`);
    const result = scanForSealed({ repo, worktrees: [] }, { stateRoot: state, maxEntries: 3 });
    expect(result.findings.map((f) => f.kind)).toEqual(["scan_incomplete"]);
  });

  it.skipIf(process.getuid?.() === 0)("gives scan_incomplete for a file it cannot read", () => {
    const state = realDir("omf-state-");
    const repo = realDir("omf-repo-");
    put(repo, "secret.txt");
    chmodSync(join(repo, "secret.txt"), 0o000);
    const result = scanForSealed({ repo, worktrees: [] }, { stateRoot: state });
    expect(summary(result.findings)).toEqual(["repo:scan_incomplete:secret.txt"]);
  });
});
