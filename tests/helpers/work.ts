import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NewWorkItem, StateStore } from "../../src/adapters/state-markdown.js";
import type { Ledger } from "../../src/core/ledger.js";
import { fingerprintOf, workIdOf } from "../../src/work/fingerprint.js";
import type { WEventType } from "../../src/work/w-events.js";
import type { IntentCandidate, RiskAssessment, Trigger, WorkItem, WorkItemFront } from "../../src/work/types.js";
import { renderWorkItem } from "../../src/work/work-item.js";

/** A fixed clock for store tests: item timestamps are asserted exactly. */
export const T0 = new Date("2026-10-12T10:00:00.000Z");
export const T1 = new Date("2026-10-12T11:00:00.000Z");

export const NORMAL_RISK: RiskAssessment = { class: "normal", rules: [], paths: ["src/render"] };
export const HIGH_RISK: RiskAssessment = { class: "high", rules: ["ci"], paths: [".github/workflows/ci.yml"] };

export function makeCandidate(title = "Cache the render path", paths: string[] = ["src/render"]): IntentCandidate {
  return {
    title,
    problem: "Rendering recomputes layout on every call.",
    proposed_outcome: "Layout is computed once per input.",
    affected_users_systems: "The render module and its callers.",
    constraints: "",
    open_questions: [],
    rationale: "Repeated work dominates the slow path.",
    affected_paths: paths,
  };
}

/** A store input for goal g-fast. Distinct titles give distinct fingerprints, so distinct work ids. */
export function makeNewItem(
  options: {
    goalId?: string;
    title?: string;
    paths?: string[];
    risk?: RiskAssessment;
    trigger?: Trigger | "both";
  } = {},
): NewWorkItem {
  const goalId = options.goalId ?? "g-fast";
  const candidate = makeCandidate(options.title, options.paths);
  return {
    goal_id: goalId,
    tick_id: "t-20261012T100000Z-ab12",
    trigger: options.trigger ?? "gap",
    candidate,
    fingerprint: fingerprintOf(goalId, candidate),
    risk: options.risk ?? NORMAL_RISK,
  };
}

/**
 * Creates an item the way reconcile does (D30): the `work.created` event first, then the files. The
 * returned item is what the store wrote.
 */
export function createRecorded(ledger: Ledger, store: StateStore, input: NewWorkItem, now: Date = T0): WorkItem {
  const workId = workIdOf(input.fingerprint);
  ledger.append({
    actor: "omf",
    type: "work.created",
    payload: {
      goal_id: input.goal_id,
      work_id: workId,
      tick_id: input.tick_id,
      fingerprint: input.fingerprint,
      state: input.risk.class === "high" ? "awaiting_approval" : "ready",
      risk_class: input.risk.class,
      risk_rules: input.risk.rules,
      item: `goals/${input.goal_id}/work/${workId}/item.md`,
    },
  });
  const result = store.createWorkItem(input, now);
  if (!result.created) throw new Error(`fixture item ${workId} already exists`);
  return result.item;
}

/** Appends a work.approved, work.vetoed or work.cancelled event for `item` as `actor`. */
export function appendWorkEvent(
  ledger: Ledger,
  type: "work.approved" | "work.vetoed" | "work.cancelled",
  actor: string,
  item: WorkItem,
  extra: Record<string, unknown> = {},
): void {
  ledger.append({ actor, type, payload: { goal_id: item.front.goal_id, work_id: item.front.work_id, ...extra } });
}

/** A run id that matches `RUN_ID_PATTERN`, for events that do not care which run wrote them. */
export const FIXTURE_RUN_ID = "r-20261012T100000Z-0001";

/** The smallest payload each W event type accepts, run id and ids aside. `extra` overrides any field. */
const W_DEFAULTS: Record<WEventType, Record<string, unknown>> = {
  "work.started": { from: "ready" },
  "work.submitted": { outcome: "success", recommendation: "merge_recommended" },
  "work.failed": { outcome: "blocked", reason_code: "infra_failure" },
  "work.parked": { outcome: "blocked", reason_code: "j2_open" },
  "work.repaired": { from: "ready", to: "in_progress", source_seq: 1 },
  "work.claim_reclaimed": { previous_pid: null, previous_acquired_at: "" },
  "work.resumed": {},
};

/**
 * Appends a valid W event for `item` as `omf`, the way a run would have (M3b1-D2: the ledger is the authority,
 * so a fixture that puts an item into a W state must also leave the event). The item file is not touched:
 * pair it with `rewriteItem` for a hand-built state, or leave it for a crash fixture. `extra` overrides fields.
 */
export function recordW(
  ledger: Ledger,
  type: WEventType,
  item: { front: Pick<WorkItemFront, "goal_id" | "work_id"> },
  extra: Record<string, unknown> = {},
): void {
  ledger.append({
    actor: "omf",
    type,
    payload: {
      goal_id: item.front.goal_id,
      work_id: item.front.work_id,
      run_id: FIXTURE_RUN_ID,
      ...W_DEFAULTS[type],
      ...extra,
    },
  });
}

/** Edits item.md on disk the way a person with a text editor would, bypassing the store and the ledger. */
export function rewriteItem(item: WorkItem, patch: Partial<WorkItemFront>): void {
  writeFileSync(join(item.dir, "item.md"), renderWorkItem({ ...item.front, ...patch }, item.progress));
}
