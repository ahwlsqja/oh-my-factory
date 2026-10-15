import { canonicalize, sha256Hex } from "../core/canonical-json.js";
import type { GateResult, GateVerdict } from "./gates.js";
import type { NodeId, StationStatus } from "./line-types.js";
import { REENTRY_KILLS_MAX, REENTRY_SAME_REASON_MAX, type WorkBudgetState } from "./w-budget.js";

/** Spec §4.4: a node may be entered 3 times per round. Always on, with the default limits too (Kilroy's 0 turns it off; this does not). */
export const VISITS_PER_STATION_PER_ROUND = 3;

/** Spec §4.4: `max(10, 20 x max_rounds)` node entries in total, gates included. */
export function totalVisitCap(maxRounds: number): number {
  return Math.max(10, 20 * maxRounds);
}

/**
 * In-memory visit counts for one run (M3b2-D6). Round 0 holds S1, S2 and their gates; `startRound` opens round 1, 2, ...
 * and resets the per-node counts but keeps the total. What bounds work across runs is the ledger (rounds, spend, the
 * re-entry facts), not this class.
 */
export class VisitCounter {
  #round = 0;
  #total = 0;
  readonly #counts = new Map<NodeId, number>();

  get round(): number {
    return this.#round;
  }

  startRound(): void {
    this.#round += 1;
    this.#counts.clear();
  }

  enter(node: NodeId): { in_round: number; total: number } {
    this.#total += 1;
    const inRound = (this.#counts.get(node) ?? 0) + 1;
    this.#counts.set(node, inRound);
    return { in_round: inRound, total: this.#total };
  }
}

/**
 * The stall signature (M3b2-D7): sha256 over the canonical form of the round's `[{node, status, digest}]`. A station
 * contributes a `digest` (for example a diff hash); one that supplies none makes an unchanged round look identical,
 * which is the safe direction. Separate from the goal-level `progressSignature`.
 */
export function roundSignature(
  entries: readonly { node: NodeId; status: StationStatus | GateVerdict; digest: string | null }[],
): string {
  return sha256Hex(canonicalize(entries.map(({ node, status, digest }) => ({ node, status, digest }))));
}

export interface Gate4Input {
  budget: WorkBudgetState;
  /** Counts after the entering visit was added. */
  visits: { in_round: number; total: number; entering: NodeId | null };
  /** True at line entry, at S3 entry, and when S6 asked for rework. */
  next_round_wanted: boolean;
  stall: { current: string | null; rework: boolean };
  /** `foldReentry`; checked at line entry only, zeros elsewhere. */
  reentry: { same_reason: number; kills: number };
}

export type Gate4Reason =
  | "limits_missing"
  | "ledger_anomaly" // integrity
  | "visit_cap"
  | "total_visit_cap"
  | "stalled"
  | "reentry_loop" // hard: the same blocker three times escalates to J6
  | "rounds_exhausted"
  | "spend_exhausted"; // soft: a person can raise the limit (J8)
export type Gate4Severity = "none" | "integrity" | "hard" | "soft";
export type Gate4Warning = "spend_unverifiable";
export interface Gate4Result {
  verdict: "pass" | "fail";
  severity: Gate4Severity;
  reasons: Gate4Reason[];
  warnings: Gate4Warning[];
}

const SEVERITY_OF: Record<Gate4Reason, Exclude<Gate4Severity, "none">> = {
  limits_missing: "integrity",
  ledger_anomaly: "integrity",
  visit_cap: "hard",
  total_visit_cap: "hard",
  stalled: "hard",
  reentry_loop: "hard",
  rounds_exhausted: "soft",
  spend_exhausted: "soft",
};
const SEVERITY_RANK = { integrity: 3, hard: 2, soft: 1 } as const;

/**
 * GATE-4, pure (spec §5.0, M3-D18). Reads the folded budget state and counters; never the clock, never the disk.
 *
 * - rounds_exhausted: a next round is wanted and `rounds_started >= effective.max_rounds`.
 * - spend_exhausted: spend over the limit, or at the limit while a next round is wanted.
 * - visit_cap: more than 3 entries of one node in the round. total_visit_cap: more than `totalVisitCap(max_rounds)`.
 * - stalled: the round asks for rework and its signature equals the previous round's.
 * - reentry_loop: the same park reason, or the same kill, 3 times since the last human act.
 * - Missing limits or any ledger anomaly fail closed. Unknown spend never fails by itself; it warns.
 *
 * Recording rule (the sequencer's): a GATE-4 result goes on the board only for the check after S6 and for any fail. A
 * pass from a line-entry, S3-entry or node-entry guard is neither on the board nor in the history, so the board never
 * shows GATE-4 pass for a line that stopped before S6.
 */
export function evaluateGate4(input: Gate4Input): Gate4Result {
  const { budget, visits, stall, reentry } = input;
  const limit = budget.effective;
  const reasons: Gate4Reason[] = [];

  if (budget.limits === null || limit === null) reasons.push("limits_missing");
  if (budget.anomalies.length > 0) reasons.push("ledger_anomaly");
  if (visits.in_round > VISITS_PER_STATION_PER_ROUND) reasons.push("visit_cap");
  if (limit !== null && visits.total > totalVisitCap(limit.max_rounds)) reasons.push("total_visit_cap");
  if (stall.rework && stall.current !== null && stall.current === budget.previous_signature) reasons.push("stalled");
  if (reentry.same_reason >= REENTRY_SAME_REASON_MAX || reentry.kills >= REENTRY_KILLS_MAX) reasons.push("reentry_loop");
  if (limit !== null && input.next_round_wanted && budget.rounds_started >= limit.max_rounds) reasons.push("rounds_exhausted");
  if (limit !== null) {
    const spent = budget.spend.micro_usd;
    if (spent > limit.max_model_micro_usd || (input.next_round_wanted && spent >= limit.max_model_micro_usd)) {
      reasons.push("spend_exhausted");
    }
  }

  let severity: Gate4Severity = "none";
  for (const reason of reasons) {
    const level = SEVERITY_OF[reason];
    if (severity === "none" || SEVERITY_RANK[level] > SEVERITY_RANK[severity]) severity = level;
  }
  const warnings: Gate4Warning[] = budget.spend.unknown_count > 0 ? ["spend_unverifiable"] : [];
  return { verdict: reasons.length === 0 ? "pass" : "fail", severity, reasons, warnings };
}

/** The board entry for a GATE-4 result: closed reason codes only. */
export function gate4Result(result: Gate4Result): GateResult {
  return { gate: "GATE-4", verdict: result.verdict, reasons: [...result.reasons] };
}
