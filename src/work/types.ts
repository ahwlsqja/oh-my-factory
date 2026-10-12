/**
 * Work-item domain types (spec §4.4 steps 4 to 5). Pure types and two state sets: nothing here touches
 * the disk or the ledger, so every other `src/work/` module can import this file without a cycle.
 */

export type WorkState =
  | "ready"
  | "awaiting_approval"
  | "in_progress"
  | "awaiting_review"
  | "done"
  | "failed"
  | "vetoed"
  | "cancelled";

/** States that count against `max_open_work_items` and that a person can still veto or cancel. */
export const OPEN_STATES: readonly WorkState[] = ["ready", "awaiting_approval", "in_progress", "awaiting_review"];

/** States nothing leaves. */
export const TERMINAL_WORK_STATES: readonly WorkState[] = ["done", "failed", "vetoed", "cancelled"];

export type RiskClass = "normal" | "high";

/** Rule labels only: an assessment never names a metric id, so it can be shown to the model and logged. */
export type RiskRule =
  | "ci"
  | "auth"
  | "migration"
  | "test"
  | "goal-factory"
  | "lockfile"
  | "watched-path"
  | "extra"
  | "undeclared"
  | "unclassifiable";

export interface RiskAssessment {
  class: RiskClass;
  rules: RiskRule[];
  paths: string[];
}

export type Trigger = "gap" | "breach";

/**
 * What the reconciler proposes (spec §4.4 step 4): Stage 1 of an intent document plus the paths it expects to touch.
 * Free text only. A number or a metric name in any field is rejected by seed lint before the candidate is stored.
 */
export interface IntentCandidate {
  title: string;
  problem: string;
  proposed_outcome: string;
  affected_users_systems: string;
  constraints: string;
  open_questions: string[];
  rationale: string;
  affected_paths: string[];
}

/** The parsed form of `intent.md`. Title and rationale live only in `candidate`. */
export interface IntentDoc {
  goal_id: string;
  work_id: string;
  fingerprint: string;
  candidate: IntentCandidate;
}

export interface WorkItemFront {
  schema_version: 1;
  work_id: string;
  goal_id: string;
  title: string;
  state: WorkState;
  fingerprint: string;
  risk: RiskAssessment;
  affected_paths: string[];
  has_open_questions: boolean;
  origin: { kind: "reconcile"; tick_id: string; trigger: Trigger | "both" };
  created_at: string;
  updated_at: string;
  /** Set by a person (`human:*`) when an `awaiting_approval` item becomes `ready`. */
  approval: { approved_by: string; approved_at: string } | null;
  /** Set by a person (`human:*`) who vetoes an open item; `reason` is at most 500 characters. */
  veto: { vetoed_by: string; vetoed_at: string; reason: string } | null;
}

export interface WorkItem {
  front: WorkItemFront;
  dir: string;
  progress: string;
  intent: IntentDoc;
}
