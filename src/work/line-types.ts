import type { EvidenceInputs } from "./classify.js";
import { PROGRESS_STATIONS } from "./w-verbs.js";

/** The seven stations of the line (spec §5.0). Same tuple the progress marker accepts, so a station id is a marker station. */
export const STATION_IDS = PROGRESS_STATIONS;
export type StationId = (typeof STATION_IDS)[number];

export const GATE_IDS = ["GATE-1", "GATE-2", "GATE-3", "GATE-4"] as const;
export type GateId = (typeof GATE_IDS)[number];
export type NodeId = StationId | GateId;

/** The one legal order. S3 opens a round; S6 may ask for another (back to S3); a GATE-2 fail goes back to S2. */
export const LINE_ORDER: readonly NodeId[] = [
  "S1",
  "GATE-1",
  "S2",
  "GATE-2",
  "S3",
  "S4",
  "S5",
  "GATE-3",
  "S6",
  "GATE-4",
  "S7",
];

/**
 * Round-scoped state is reset in the same step that opens a round, so a round-1 result can never satisfy
 * round 2. GATE-1 and GATE-2 are line-wide; `isolation_level` is run-wide.
 */
export const ROUND_SCOPED_GATES: readonly GateId[] = ["GATE-3", "GATE-4"];
export const ROUND_SCOPED_STATIONS: readonly StationId[] = ["S3", "S4", "S5", "S6", "S7"];
export const ROUND_SCOPED_INPUTS: readonly (keyof EvidenceInputs)[] = [
  "audit",
  "sealed",
  "noise_check",
  "high_risk_paths_touched",
  "gate_line",
  "gate_verdict",
  "plan_summary",
  "implementer_notes",
];

/** What a field holds when nobody produced it. Never a pass, never a zero (E7a). */
export const NOT_RUN = "not run" as const;
export type NotRun = typeof NOT_RUN;

export type StationStatus = "ok" | "rework" | "skipped" | "blocked" | "manual" | "error" | "not_run";

/** What automated verification did not cover. Every code is a closed identifier, never text. */
export type UnverifiedCode =
  | "decision_unmeasured" // a quantitative decision has measured: not run; decision_id set
  | "model_spend_unverifiable" // some work.spend event is unknown
  | "noise_check_not_run" // the test run produces it
  | "noise_check_not_evaluated" // the check ran but could not decide
  | "high_risk_paths_not_run" // the audit produces it
  | "high_risk_paths_touched" // diff review required at J4
  | "decisions_masked" // a decision id or threshold failed the leak check, or the leak context could not be loaded (decision_id null)
  | "injected_gate"; // a gate came from outside defaultGates() (decision_id null)
export interface UnverifiedArea {
  code: UnverifiedCode;
  decision_id: string | null;
}
