import { existsSync, lstatSync, opendirSync } from "node:fs";
import { join } from "node:path";
import { createMarkdownStore } from "../adapters/state-markdown.js";
import { Ledger, type LedgerEvent } from "../core/ledger.js";
import { type ProjectLocation, resolveProject } from "../core/paths.js";
import { NOT_INITIALIZED_MESSAGE, requireProject } from "../core/project.js";
import { assertNoSymlinksBelow, realProjectDir, SymlinkRefusedError } from "../core/safe-fs.js";
import { gate1ForItem } from "../decision/gate1-item.js";
import { auditGoal } from "../goal/audit.js";
import { GOAL_ID_PATTERN, METRIC_ID_PATTERN } from "../goal/goal-file.js";
import { runStateFromEvents } from "../goal/run-state.js";
import { trustedRecommendation } from "../work/evidence.js";
import { verifiedItems } from "../work/ledger-verify.js";
import type { WorkItem, WorkState } from "../work/types.js";
import {
  UI_EVENT_TYPES,
  type UiEvent,
  type UiGapPoint,
  type UiGoal,
  type UiSnapshot,
  type UiWarning,
  type UiWorkItem,
} from "./types.js";

const MAX_GOALS = 50;
const MAX_ITEMS = 500;
const MAX_EVENTS = 100;
const MAX_HISTORY = 30;
// Input limits reduce accidental resource exhaustion; the recursive symlink guard has no hard time bound.
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const MAX_LEDGER_EVENTS = 20_000;
const MAX_GOAL_ENTRIES = 1_000;
const MAX_WORK_ENTRIES = 1_000;
const MAX_TOTAL_WORK_ENTRIES = 2_000;
const MAX_STATE_FILE_BYTES = 1024 * 1024;
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const MAX_METRIC_ENTRIES = 1_000;
const WORK_ID = /^w-[0-9a-f]{12}$/;
const TICK_ID = /^t-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{4}$/;
const HASH = /^[0-9a-f]{64}$/;
const STATES: readonly WorkState[] = [
  "ready",
  "awaiting_approval",
  "in_progress",
  "awaiting_review",
  "done",
  "failed",
  "vetoed",
  "cancelled",
];
const HUMAN_CODES = [
  "interface_missing",
  "interface_unresolved",
  "intent_question_missing",
  "required_open",
  "deferral_expired",
  "resolution_not_human",
  "deferral_unsigned",
  "record_invalid",
  "ledger_anomaly",
] as const;

function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 32 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function goalId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && GOAL_ID_PATTERN.test(value);
}

function workId(value: unknown): value is string {
  return typeof value === "string" && WORK_ID.test(value);
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function empty(status: UiSnapshot["status"], warning?: UiWarning): UiSnapshot {
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    ledger_head: null,
    status,
    goals: [],
    events: [],
    warnings: warning === undefined ? [] : [warning],
    truncated: false,
  };
}

function failure(error: unknown): UiSnapshot {
  if (error instanceof ResourceLimitError) return empty("unavailable", "resource_limit");
  if (error instanceof SymlinkRefusedError) return empty("unavailable", "symlink_refused");
  if (error instanceof Error && error.message === NOT_INITIALIZED_MESSAGE)
    return empty("uninitialized", "project_uninitialized");
  if (error instanceof Error && error.message.startsWith("ledger corrupt at seq "))
    return empty("corrupt", "ledger_corrupt");
  return empty("unavailable", "project_unavailable");
}

function timeline(events: readonly LedgerEvent[]): UiEvent[] {
  const result: UiEvent[] = [];
  for (let index = events.length - 1; index >= 0 && result.length <= MAX_EVENTS; index--) {
    const event = events[index];
    if (event === undefined) continue;
    const type = UI_EVENT_TYPES.find((allowed) => allowed === event.type);
    if (type === undefined || !timestamp(event.ts) || !Number.isSafeInteger(event.seq) || event.seq < 1) continue;
    const goal = event.payload.goal_id;
    const work = event.payload.work_id;
    if (type !== "project.initialized" && !goalId(goal)) continue;
    if (type.startsWith("work.") && !workId(work)) continue;
    result.push({
      seq: event.seq,
      at: event.ts,
      type,
      goal_id: goalId(goal) ? goal : null,
      work_id: workId(work) ? work : null,
    });
  }
  return result.reverse();
}

class ResourceLimitError extends Error {}

/** Enumerate a bounded number of entries without allocating an unbounded readdir result. */
function directoryNames(path: string, limit: number, directoriesOnly = true): string[] {
  if (!existsSync(path)) return [];
  const names: string[] = [];
  const directory = opendirSync(path);
  try {
    let count = 0;
    for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
      if (++count > limit) throw new ResourceLimitError();
      if (!directoriesOnly || entry.isDirectory()) names.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  return names.sort();
}

/** Check sizes and bounded directory names before requireProject's ledger read and recursive guard. */
function inputGuard(location: ProjectLocation, env: NodeJS.ProcessEnv): void {
  let real: { root: string; dir: string };
  try {
    real = realProjectDir(location, env);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const ledger = join(real.dir, "ledger.jsonl");
  assertNoSymlinksBelow(real.root, ledger);
  if (existsSync(ledger)) {
    const stat = lstatSync(ledger);
    if (!stat.isFile() || stat.size > MAX_LEDGER_BYTES) throw new ResourceLimitError();
  }
  let bytes = 0;
  const file = (path: string): void => {
    assertNoSymlinksBelow(real.root, path);
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_STATE_FILE_BYTES) throw new ResourceLimitError();
    bytes += stat.size;
    if (bytes > MAX_STATE_BYTES) throw new ResourceLimitError();
  };
  const metricFiles = (path: string): void => {
    assertNoSymlinksBelow(real.root, path);
    for (const name of directoryNames(path, MAX_METRIC_ENTRIES, false)) {
      if (name === "goal.lock.json" || /^m-[a-z0-9]+(?:-[a-z0-9]+)*\.(?:lock\.json|json|yaml)$/.test(name))
        file(join(path, name));
    }
  };
  metricFiles(join(real.dir, "vault", "metrics", "proposed"));
  const goals = join(real.dir, "goals");
  assertNoSymlinksBelow(real.root, goals);
  let total = 0;
  for (const id of directoryNames(goals, MAX_GOAL_ENTRIES).filter(goalId).slice(0, MAX_GOALS)) {
    file(join(goals, id, "goal.md"));
    metricFiles(join(real.dir, "vault", "metrics", id));
    metricFiles(join(goals, id, "bands"));
    const work = join(goals, id, "work");
    assertNoSymlinksBelow(real.root, work);
    const items = directoryNames(work, MAX_WORK_ENTRIES);
    total += items.length;
    if (total > MAX_TOTAL_WORK_ENTRIES) throw new ResourceLimitError();
    for (const item of items.filter(workId)) {
      for (const name of ["item.md", "intent.md", "evidence.json"]) file(join(work, item, name));
    }
  }
}

function approvalInputsGuard(events: readonly LedgerEvent[]): void {
  for (const event of events) {
    if (event.type !== "goal.approved") continue;
    const metrics = event.payload.metrics;
    if (!Array.isArray(metrics)) continue;
    if (
      metrics.length > MAX_METRIC_ENTRIES ||
      metrics.some((id) => typeof id !== "string" || id.length > 128 || !METRIC_ID_PATTERN.test(id))
    )
      throw new ResourceLimitError();
  }
}

function gapHistory(events: readonly LedgerEvent[], id: string, approved: boolean): UiGapPoint[] {
  if (!approved) return [];
  const approval = events.findLast(
    (event) => event.type === "goal.approved" && event.payload.goal_id === id && /^human:\S+$/.test(event.actor),
  );
  if (approval === undefined) return [];
  const result: UiGapPoint[] = [];
  for (let index = events.length - 1; index >= 0 && result.length <= MAX_HISTORY; index--) {
    const event = events[index];
    if (event === undefined) continue;
    if (event.seq <= approval.seq) break;
    if (
      event.type !== "reconcile.requested" ||
      event.actor !== "omf" ||
      event.payload.goal_id !== id ||
      !timestamp(event.ts)
    )
      continue;
    const tick = event.payload.tick_id;
    if (typeof tick !== "string" || !TICK_ID.test(tick)) continue;
    const gap = object(object(event.payload.disclosed)?.gap);
    if (
      gap === null ||
      (gap.direction !== "increase" && gap.direction !== "decrease") ||
      (gap.size !== "small" && gap.size !== "medium" && gap.size !== "large")
    )
      continue;
    result.push({ seq: event.seq, at: event.ts, direction: gap.direction, size: gap.size });
  }
  return result.reverse();
}

/** Existing domain trust rule only. File-only detail codes cannot be authenticated and are withheld. */
function evidence(item: WorkItem, events: readonly LedgerEvent[]): UiWorkItem["evidence"] {
  const recommendation = trustedRecommendation(item.dir, events, item.front);
  return recommendation === "none" ? null : { recommendation };
}

function readGoalView(
  location: ReturnType<typeof requireProject>,
  events: readonly LedgerEvent[],
  id: string,
  remaining: number,
): UiGoal {
  const result: UiGoal = {
    goal_id: id,
    audit_state: "unavailable",
    run_state: "unavailable",
    ticks: 0,
    work_counts: {
      ready: 0,
      awaiting_approval: 0,
      in_progress: 0,
      awaiting_review: 0,
      done: 0,
      failed: 0,
      vetoed: 0,
      cancelled: 0,
    },
    gap: null,
    gap_history: [],
    work_items: [],
    needs_human: [],
    warnings: [],
    truncated: false,
  };
  const warn = (code: UiWarning): void => {
    if (!result.warnings.includes(code)) result.warnings.push(code);
  };
  try {
    const audit = auditGoal(location, id);
    result.audit_state = audit.state;
    if (audit.state === "needs_reapproval") result.needs_human.push({ code: "J1", work_id: null });
    if (audit.state === "tampered") {
      result.needs_human.push({ code: "goal_integrity_attention", work_id: null });
      warn("goal_integrity_attention");
    }
    if (audit.state === "invalid") {
      result.needs_human.push({ code: "goal_invalid", work_id: null });
      warn("goal_invalid");
    }
  } catch {
    warn("goal_unavailable");
    warn("needs_human_unavailable");
  }
  try {
    const run = runStateFromEvents(events, id);
    result.run_state = run.status;
    result.ticks = Number.isSafeInteger(run.ticks) && run.ticks >= 0 ? run.ticks : 0;
    if (
      run.open_escalation !== null &&
      !result.needs_human.some((need) => need.work_id === null && need.code === run.open_escalation?.j)
    )
      result.needs_human.push({ code: run.open_escalation.j, work_id: null });
  } catch {
    warn("goal_unavailable");
    warn("needs_human_unavailable");
  }
  const history = gapHistory(events, id, result.audit_state === "approved");
  result.gap_history = history.slice(-MAX_HISTORY);
  const latest = history.at(-1);
  if (
    latest !== undefined &&
    !events.some((event) => event.seq > latest.seq && event.type === "goal.measured" && event.payload.goal_id === id)
  )
    result.gap = latest;
  if (result.gap === null) warn("gap_unavailable");
  if (history.length > MAX_HISTORY) result.truncated = true;
  try {
    const verified = verifiedItems(createMarkdownStore(location.dir), events, id);
    if (verified.malformed.length > 0) {
      warn("work_projection_invalid");
      warn("needs_human_unavailable");
    }
    const items = verified.items.filter(
      (item) =>
        workId(item.front.work_id) &&
        goalId(item.front.goal_id) &&
        STATES.includes(item.front.state) &&
        (item.front.risk.class === "normal" || item.front.risk.class === "high"),
    );
    for (const item of items) result.work_counts[item.front.state] += 1;
    result.truncated ||= items.length > remaining;
    for (const item of items.slice(0, remaining)) {
      let proof: UiWorkItem["evidence"] = null;
      try {
        proof = evidence(item, events);
      } catch {
        warn("evidence_unavailable");
      }
      if (proof === null && existsSync(join(item.dir, "evidence.json"))) warn("evidence_unavailable");
      result.work_items.push({
        work_id: item.front.work_id,
        state: item.front.state,
        risk: item.front.risk.class,
        evidence: proof,
      });
      if (item.front.state === "awaiting_approval")
        result.needs_human.push({ code: "approval_required", work_id: item.front.work_id });
      if (item.front.state === "ready" || item.front.state === "in_progress") {
        try {
          const gate = gate1ForItem(location, item, events, new Date()).result;
          if (gate.status === "blocked_on_user")
            for (const reason of gate.reasons) {
              const code = HUMAN_CODES.find((allowed) => allowed === reason.code);
              if (
                code !== undefined &&
                !result.needs_human.some((need) => need.work_id === item.front.work_id && need.code === code)
              )
                result.needs_human.push({ code, work_id: item.front.work_id });
            }
        } catch {
          warn("needs_human_unavailable");
        }
      }
    }
  } catch {
    warn("work_projection_invalid");
    warn("needs_human_unavailable");
  }
  if (result.truncated) warn("truncated");
  return result;
}

/** No initialization, healing, measurement, projection refresh or state writes occur on this path. */
export function readUiSnapshot(cwd: string, env: NodeJS.ProcessEnv = process.env): UiSnapshot {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      inputGuard(resolveProject(cwd, env), env);
      const location = requireProject(cwd, env);
      const ledger = new Ledger(location.dir);
      const before = ledger.inspect();
      if (!before.result.ok) return empty("corrupt", "ledger_corrupt");
      if (before.events.length > MAX_LEDGER_EVENTS) return empty("unavailable", "resource_limit");
      approvalInputsGuard(before.events);
      const snapshot = empty("ok");
      snapshot.ledger_head = before.result.head;
      if (attempt > 0) snapshot.warnings.push("concurrent_change");
      if (before.result.tornTail) snapshot.warnings.push("ledger_torn_tail");
      const root = join(location.dir, "goals");
      const names = directoryNames(root, MAX_GOAL_ENTRIES).filter(goalId);
      snapshot.truncated = names.length > MAX_GOALS;
      let remaining = MAX_ITEMS;
      for (const id of names.slice(0, MAX_GOALS)) {
        // Omit later goals explicitly rather than reading them with no card budget or inventing zero counts.
        if (remaining === 0) {
          snapshot.truncated = true;
          break;
        }
        const goal = readGoalView(location, before.events, id, remaining);
        remaining -= goal.work_items.length;
        snapshot.goals.push(goal);
        snapshot.truncated ||= goal.truncated;
      }
      const events = timeline(before.events);
      snapshot.events = events.slice(-MAX_EVENTS);
      snapshot.truncated ||= events.length > MAX_EVENTS;
      if (snapshot.truncated) snapshot.warnings.push("truncated");
      // auditGoal re-reads the ledger. Discard the entire view if any reader crossed a revision.
      inputGuard(location, env);
      requireProject(cwd, env);
      const after = ledger.inspect();
      if (!after.result.ok) return empty("corrupt", "ledger_corrupt");
      if (before.result.head !== after.result.head) continue;
      if (!HASH.test(snapshot.ledger_head)) return empty("corrupt", "ledger_corrupt");
      return snapshot;
    } catch (error) {
      return failure(error);
    }
  }
  return empty("unavailable", "concurrent_change");
}
