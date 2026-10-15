import type { LedgerEvent } from "../../src/core/ledger.js";
import { type Classification, type EvidenceInputs, emptyEvidenceInputs } from "../../src/work/classify.js";
import type { EvidenceBuild, EvidenceDoc } from "../../src/work/evidence.js";
import { GateBoard, type GateVerdict } from "../../src/work/gates.js";
import { GATE_IDS, NOT_RUN, STATION_IDS, type StationId, type StationStatus } from "../../src/work/line-types.js";
import { foldWorkBudget } from "../../src/work/w-budget.js";

export const WORK = "w-0123456789ab";
export const GOAL = "g-demo";
export const RUN = "r-20261014T091500Z-ab12";
export const NOW = new Date("2026-10-14T09:20:00.000Z");
export const SCOPE = { work_id: WORK, goal_id: GOAL, run_id: RUN };

export const LATENCY: EvidenceDoc["decisions"][number] = {
  id: "d-latency",
  threshold: 250,
  measured: NOT_RUN,
  status: "resolved",
};

export const SUCCESS: Classification = {
  outcome: "success",
  exhausted: false,
  reason_code: null,
  recommendation: "merge_recommended",
  unverified_areas: [],
  rule: "success",
};
export const FLAWED: Classification = {
  ...SUCCESS,
  outcome: "flawed",
  reason_code: "audit_flag",
  recommendation: "not_recommended",
  rule: "audit_flag",
};
export const BLOCKED: Classification = {
  outcome: "blocked",
  exhausted: false,
  reason_code: "evidence_incomplete",
  recommendation: "human_needed",
  unverified_areas: [{ code: "noise_check_not_run", decision_id: null }],
  rule: "evidence_incomplete",
};

export function allStations(status: StationStatus): Record<StationId, StationStatus> {
  return Object.fromEntries(STATION_IDS.map((id) => [id, status])) as Record<StationId, StationStatus>;
}

export function boardOf(verdict: GateVerdict): GateBoard {
  const board = new GateBoard();
  for (const gate of GATE_IDS) board.record({ gate, verdict, reasons: [] });
  return board;
}

/** Every input produced and clean: the only bag a merge_recommended may come from. */
export function cleanInputs(): EvidenceInputs {
  return {
    audit: { canary_hits: 0, tests_edited: false, prove_test: "pass", judge_config_touched: false },
    sealed: { train: { pass: 3, total: 3, flaky: 0 }, test: { pass: 2, total: 2 } },
    isolation_level: "L2",
    high_risk_paths_touched: [],
    noise_check: "ok",
    gate_line: "OMF_GATES fast=pass",
    plan_summary: "Add a cache.",
    implementer_notes: "Done.",
  };
}

/** A clean success: every gate pass, every station ok, every input produced. */
export function cleanBuild(over: Partial<EvidenceBuild> = {}): EvidenceBuild {
  return {
    scope: SCOPE,
    classification: SUCCESS,
    stations: allStations("ok"),
    gates: boardOf("pass"),
    inputs: cleanInputs(),
    decisions: { list: [], masked: false },
    injected_gates: [],
    stage_times: { S1: { visits: 1, total_ms: 20 } },
    budget: foldWorkBudget([], WORK),
    now: NOW,
    ...over,
  };
}

/** The default line today: nothing visited, nothing produced. */
export function notRunBuild(over: Partial<EvidenceBuild> = {}): EvidenceBuild {
  return cleanBuild({
    classification: BLOCKED,
    stations: allStations("not_run"),
    gates: new GateBoard(),
    inputs: emptyEvidenceInputs(),
    stage_times: {},
    ...over,
  });
}

/** A ledger event as the verified ledger would return it; only seq, actor, type and payload matter to the readers under test. */
export function fakeEvent(seq: number, type: string, payload: Record<string, unknown>, actor = "omf"): LedgerEvent {
  return {
    schema_version: 1,
    seq,
    prev_hash: "0".repeat(64),
    ts: "2026-10-14T09:21:00.000Z",
    actor,
    type,
    payload,
    hash: "1".repeat(64),
  };
}
