import type { Gate1Reason } from "../decision/gate1.js";
import type { GoalState } from "../goal/audit.js";
import type { RunState } from "../goal/run-state.js";
import type { RiskClass, WorkState } from "../work/types.js";
import type { Recommendation } from "../work/w-events.js";

/** This boundary deliberately contains no domain documents or arbitrary display text. */
export type UiWarning =
  | "project_uninitialized"
  | "project_unavailable"
  | "ledger_corrupt"
  | "ledger_torn_tail"
  | "symlink_refused"
  | "concurrent_change"
  | "resource_limit"
  | "goal_unavailable"
  | "work_projection_invalid"
  | "evidence_unavailable"
  | "needs_human_unavailable"
  | "gap_unavailable"
  | "truncated";

export const UI_EVENT_TYPES = [
  "project.initialized",
  "goal.approved",
  "goal.tick_started",
  "goal.tick_ended",
  "goal.measured",
  "goal.escalated",
  "goal.terminated",
  "goal.resumed",
  "goal.stale",
  "reconcile.requested",
  "work.created",
  "work.approved",
  "work.vetoed",
  "work.cancelled",
  "work.started",
  "work.submitted",
  "work.failed",
  "work.parked",
  "work.repaired",
  "work.resumed",
] as const;

export interface UiEvent {
  seq: number;
  at: string;
  type: (typeof UI_EVENT_TYPES)[number];
  goal_id: string | null;
  work_id: string | null;
}

/** A past disclosure, never a numeric measurement series or a fresh measurement. */
export interface UiGapPoint {
  seq: number;
  at: string;
  direction: "decrease" | "increase";
  size: "small" | "medium" | "large";
}

export interface UiWorkItem {
  work_id: string;
  state: WorkState;
  risk: RiskClass;
  /** Recommendation only: mutable report details are not authenticated by the ledger. */
  evidence: { recommendation: Recommendation } | null;
}

export interface UiHumanNeed {
  code: Gate1Reason["code"] | "J1" | "J6" | "J8" | "approval_required";
  work_id: string | null;
}

export interface UiGoal {
  goal_id: string;
  audit_state: GoalState | "unavailable";
  run_state: RunState["status"] | "unavailable";
  ticks: number;
  work_counts: Record<WorkState, number>;
  gap: UiGapPoint | null;
  gap_history: UiGapPoint[];
  work_items: UiWorkItem[];
  needs_human: UiHumanNeed[];
  warnings: UiWarning[];
  truncated: boolean;
}

export interface UiSnapshot {
  schema_version: 1;
  generated_at: string;
  ledger_head: string | null;
  status: "ok" | "uninitialized" | "unavailable" | "corrupt";
  goals: UiGoal[];
  events: UiEvent[];
  warnings: UiWarning[];
  truncated: boolean;
}
