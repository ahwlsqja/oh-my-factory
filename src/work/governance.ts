import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../core/canonical-json.js";
import { ConfigError, parseConfig } from "../core/config.js";
import { Ledger, LedgerCorruptError, type LedgerEvent } from "../core/ledger.js";
import type { ProjectLocation } from "../core/paths.js";
import { type AuditReport, auditGoal } from "../goal/audit.js";
import { runStateFromEvents } from "../goal/run-state.js";

/**
 * Why governance could not be read as a running, approved goal (spec §11, rule 5). A closed list: the
 * texts built from it can reach a `WRun`, a `WError` and the ledger stream, so no audit text (metric ids,
 * watched paths, lock messages) is ever copied into it (M3b1-D3).
 */
export type GovernanceCode =
  | "config_unreadable"
  | "goal_unreadable"
  | "ledger_corrupt"
  | "goal_not_approved"
  | "needs_reapproval"
  | "tampered"
  | "goal_stopped";

/** Digests only: nothing from GoalDoc, AuditReport or the metrics reaches a WRun. */
export interface Governance {
  /** sha256 of the exact bytes of config.toml that were parsed. */
  config_sha256: string;
  /** The approved regime of the goal (J1). */
  regime: number;
  /** The approval's semantic hash: the digest of the locked goal fields. */
  goal_digest: string;
}

/** Every problem found, as closed codes. The message is the codes joined, nothing else. */
export class GovernanceError extends Error {
  constructor(readonly problems: readonly GovernanceCode[]) {
    super(problems.join(","));
    this.name = "GovernanceError";
  }
}

/**
 * Reads config.toml once, as bytes: the same buffer is parsed and hashed, so a rewrite between two reads
 * cannot give a hash that does not belong to the parsed text. A missing or unparseable file throws and is
 * never replaced by defaults (rule 5). The parsed value is dropped; only the hash is kept.
 */
function configDigest(projectDir: string): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(projectDir, "config.toml"));
  } catch {
    throw new ConfigError("config.toml unreadable");
  }
  parseConfig(bytes.toString("utf8"));
  return sha256Hex(bytes);
}

/**
 * Rule 5 for one W entry. It stops, never defaults, unless every one of these holds:
 * config.toml parses; the ledger verifies; `auditGoal` says `approved` (so goal.md is readable, no lock is
 * tampered, no regime change is pending); and the goal's run state is `running`. A goal that is
 * `blocked_on_user`, `failed` or finished raises `goal_stopped`: the J6 and J8 default is to stay stopped,
 * and a wall-time overrun is already escalated to `blocked_on_user` by the tick.
 *
 * goal.md is read through `auditGoal`, which reports an unreadable one as state `invalid`
 * (`goal_unreadable`), so the file is parsed once, not twice. Independent problems are all reported.
 */
export function readGovernance(location: ProjectLocation, goalId: string, now: Date): Governance {
  const problems: GovernanceCode[] = [];
  const add = (code: GovernanceCode): void => {
    if (!problems.includes(code)) problems.push(code);
  };

  let config_sha256 = "";
  try {
    config_sha256 = configDigest(location.dir);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    add("config_unreadable");
  }

  let events: LedgerEvent[] | null = null;
  let audit: AuditReport | null = null;
  try {
    events = new Ledger(location.dir).readVerified();
    audit = auditGoal(location, goalId, now);
  } catch (err) {
    if (!(err instanceof LedgerCorruptError)) throw err;
    add("ledger_corrupt");
  }

  if (audit !== null) {
    if (audit.state === "invalid") add("goal_unreadable");
    else if (audit.state === "draft") add("goal_not_approved");
    else if (audit.state === "needs_reapproval") add("needs_reapproval");
    else if (audit.state === "tampered" || audit.approval === null || audit.locked === null) add("tampered");
  }

  if (events !== null) {
    try {
      if (runStateFromEvents(events, goalId).status !== "running") add("goal_stopped");
    } catch {
      // A goal event written outside the §5.1 rules stops the line (run-state.ts); it is a ledger problem.
      add("ledger_corrupt");
    }
  }

  if (problems.length > 0) throw new GovernanceError(problems);
  const approval = audit?.approval;
  // Unreachable: no problem means the audit ran and found an approval. Kept so the types need no assertion.
  if (approval === null || approval === undefined) throw new GovernanceError(["goal_not_approved"]);
  return { config_sha256, regime: approval.regime, goal_digest: approval.semantic_sha256 };
}

/**
 * null when the two readings are equal. A config edit is reported before a regime change, so a re-lock
 * can never hide that config.toml also moved. `WRun.recheck` turns either answer into a stop.
 */
export function governanceDrift(before: Governance, after: Governance): "config_changed" | "regime_changed" | null {
  if (before.config_sha256 !== after.config_sha256) return "config_changed";
  if (before.regime !== after.regime || before.goal_digest !== after.goal_digest) return "regime_changed";
  return null;
}
