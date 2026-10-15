import type { WorkAudit } from "../audit/work-audit.js";
import {
  ISOLATION_LEVELS,
  type IsolationLevel,
  type MeasuredLevel,
  type RunIsolation,
  compareLevel,
} from "../isolation/types.js";
import type { GateRunResult } from "./run-gates.js";

/**
 * GATE-3, integrity (spec §5.0): no canary hit, no judge-config change, no contradiction canary passing, a gate
 * line that is not MISCONFIGURED, and an isolation level measured at least as high as declared. It is a pure
 * function over `Measured`. Every missing measurement is its own failing state, so nothing here can pass by
 * default (E7).
 */

export type CanaryState = "clean" | "hit" | "not_run";
/** `unchanged` is the file half; the registered GATE-3 adds the harness-image half (`imageCheck`) before it trusts the value. */
export type JudgeConfigState = "unchanged" | "changed" | "not_run";
/** "failing" is the healthy state: the judge rejects the contradiction. */
export type ContradictionCanaryState = "failing" | "passing" | "not_run";
export type GateLineState = "green" | "red" | "misconfigured" | "not_run";

export interface Measured {
  canary: CanaryState;
  judge_config: JudgeConfigState;
  contradiction_canary: ContradictionCanaryState;
  gate_line: GateLineState;
  isolation: { declared: IsolationLevel; measured: MeasuredLevel };
}

/** In the order `failed` lists them; the ledger schema enum is compared with this list by a test. */
export const GATE3_CONDITIONS = [
  "canary_hit",
  "canary_not_scanned",
  "judge_config_changed",
  "judge_config_not_checked",
  "contradiction_canary_passing",
  "contradiction_canary_not_run",
  "gate_line_misconfigured",
  "gate_line_not_run",
  "isolation_below_declared",
  "isolation_unmeasured",
] as const;
export type Gate3Condition = (typeof GATE3_CONDITIONS)[number];

export const GATE3_ROUTES = ["none", "J6", "J7"] as const;
export type Gate3Route = (typeof GATE3_ROUTES)[number];

/**
 * `failed` always lists every condition found; `route` is J7 when any isolation condition is present, else J6, else none.
 * `route` is advisory: it is recorded in `gate3.evaluated`, and the line's J act comes from the outcome classifier,
 * not from this field.
 */
export interface Gate3Result {
  passed: boolean;
  failed: Gate3Condition[];
  route: Gate3Route;
}

const ISOLATION_CONDITIONS: ReadonlySet<Gate3Condition> = new Set<Gate3Condition>([
  "isolation_below_declared",
  "isolation_unmeasured",
]);

/**
 * Passes only when no condition is listed. `red` passes: a failing gate is a gate result for GATE-4, not an integrity
 * break. A value outside the closed lists is read as not run, never as healthy.
 */
export function evaluateGate3(measured: Measured): Gate3Result {
  const found = new Set<Gate3Condition>();
  if (measured.canary === "hit") found.add("canary_hit");
  else if (measured.canary !== "clean") found.add("canary_not_scanned");
  if (measured.judge_config === "changed") found.add("judge_config_changed");
  else if (measured.judge_config !== "unchanged") found.add("judge_config_not_checked");
  if (measured.contradiction_canary === "passing") found.add("contradiction_canary_passing");
  else if (measured.contradiction_canary !== "failing") found.add("contradiction_canary_not_run");
  if (measured.gate_line === "misconfigured") found.add("gate_line_misconfigured");
  else if (measured.gate_line !== "green" && measured.gate_line !== "red") found.add("gate_line_not_run");
  const { declared, measured: level } = measured.isolation;
  // A declared level outside the closed list cannot be compared, so it cannot be met: `compareLevel` would give NaN and pass (E7).
  if (!(ISOLATION_LEVELS as readonly string[]).includes(declared)) found.add("isolation_below_declared");
  if (!(ISOLATION_LEVELS as readonly string[]).includes(level)) found.add("isolation_unmeasured");
  else if (compareLevel(level, declared) < 0) found.add("isolation_below_declared");

  const failed = GATE3_CONDITIONS.filter((condition) => found.has(condition));
  const route: Gate3Route = failed.some((condition) => ISOLATION_CONDITIONS.has(condition))
    ? "J7"
    : failed.length > 0
      ? "J6"
      : "none";
  return { passed: failed.length === 0, failed, route };
}

export interface Gate3Parts {
  /** From `loadAudit` (checked against the ledger event), never from the raw audit.json. */
  audit: WorkAudit | null;
  gates: Pick<GateRunResult, "verdict"> | null;
  /** From `contradictionState`, never from GATE-2. */
  contradiction: ContradictionCanaryState | null;
  /** From `loadRunIsolation` (the ledger is the authority), never from preflight.json. */
  isolation: RunIsolation | null;
  declared: IsolationLevel;
}

/**
 * Builds `Measured` from the real parts. A missing part is `not_run` or `unmeasured`, never the healthy state.
 * A canary hit wins over a truncated scan (a hit is evidence); a scan that was truncated or did not run is
 * `not_run`, so a file padded past a cap cannot read as clean. `judge_config` is `not_run` when no judge file
 * was checked at all. A run level counts only when all four stages were measured.
 */
export function measuredFrom(parts: Gate3Parts): Measured {
  const { audit, gates, isolation } = parts;
  let canary: CanaryState = "not_run";
  let judge_config: JudgeConfigState = "not_run";
  if (audit !== null) {
    if (audit.canary.total > 0 || audit.canary.hits.length > 0) canary = "hit";
    else if (audit.canary.status === "scanned" && !audit.canary.truncated) canary = "clean";
    if (audit.judge_config_touched) judge_config = "changed";
    else if (audit.judge_files_checked > 0) judge_config = "unchanged";
  }
  const gate_line: GateLineState =
    gates === null
      ? "not_run"
      : gates.verdict.status === "GREEN"
        ? "green"
        : gates.verdict.status === "RED"
          ? "red"
          : "misconfigured";
  return {
    canary,
    judge_config,
    contradiction_canary: parts.contradiction ?? "not_run",
    gate_line,
    isolation: {
      declared: parts.declared,
      measured: isolation !== null && isolation.complete ? isolation.level : "unmeasured",
    },
  };
}

/** What the judge reports for the `contradiction_canary` scenarios (counts only; M3f supplies it). */
export interface ContradictionVerdict {
  judged_sha: string;
  contradiction_scenarios: number;
  rejected: number;
}

/** A full-length lowercase hex commit id (SHA-1 or SHA-256 object format). */
function isCommitId(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

/**
 * The only way a verdict becomes `ContradictionCanaryState`. Only a verdict run against the candidate sha counts:
 * GATE-2's result against the stubs is `failing` by construction and would always read healthy. No verdict, another
 * sha, a sha that is not a full lowercase hex commit id (40 or 64 digits), no contradiction scenario or an impossible
 * count is `not_run`.
 */
export function contradictionState(
  verdict: ContradictionVerdict | null,
  candidateSha: string,
): ContradictionCanaryState {
  if (
    verdict === null ||
    !isCommitId(candidateSha) ||
    !isCommitId(verdict.judged_sha) ||
    verdict.judged_sha !== candidateSha
  ) {
    return "not_run";
  }
  const { contradiction_scenarios: total, rejected } = verdict;
  if (!Number.isInteger(total) || !Number.isInteger(rejected) || total < 1 || rejected < 0 || rejected > total)
    return "not_run";
  return rejected === total ? "failing" : "passing";
}
