import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NewWorkItem, StateStore } from "../../src/adapters/state-markdown.js";
import type { Ledger } from "../../src/core/ledger.js";
import { fingerprintOf, workIdOf } from "../../src/work/fingerprint.js";
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
  options: { goalId?: string; title?: string; paths?: string[]; risk?: RiskAssessment; trigger?: Trigger | "both" } = {},
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

/** Edits item.md on disk the way a person with a text editor would, bypassing the store and the ledger. */
export function rewriteItem(item: WorkItem, patch: Partial<WorkItemFront>): void {
  writeFileSync(join(item.dir, "item.md"), renderWorkItem({ ...item.front, ...patch }, item.progress));
}
