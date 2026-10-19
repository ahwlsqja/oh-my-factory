import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomic } from "../core/private-fs.js";
import { GOAL_ID_PATTERN, assertGoalId } from "../goal/goal-file.js";
import { withItemLock } from "../work/claim.js";
import { workIdOf } from "../work/fingerprint.js";
import { type IntentDoc, parseIntent, renderIntent } from "../work/intent-md.js";
import { canTransition } from "../work/transitions.js";
import type {
  IntentCandidate,
  RepairTarget,
  RiskAssessment,
  Trigger,
  WorkItem,
  WorkItemFront,
  WorkState,
} from "../work/types.js";
import { WorkItemError, parseWorkItem, renderWorkItem, validateWorkItem } from "../work/work-item.js";

const WORK_ID_PATTERN = /^w-[0-9a-f]{12}$/;
const ITEM_FILE = "item.md";
const INTENT_FILE = "intent.md";

export interface NewWorkItem {
  goal_id: string;
  tick_id: string;
  trigger: Trigger | "both";
  candidate: IntentCandidate;
  fingerprint: string;
  risk: RiskAssessment;
}

export type CreateResult = { created: true; item: WorkItem } | { created: false; reason: "exists"; work_id: string };

/**
 * What a progress marker may say: a station S1 to S7, one space, one lowercase step word. The
 * grammar is closed on purpose: it has no digit and no free text, so neither a metric name, a target nor a
 * measured value can be written into the item, and it cannot contain the progress region's own comment markers
 * (spec §8 keeps metric values out of trackers). The caller renders the text from closed lists; the store checks.
 */
export const PROGRESS_MARKER_PATTERN = /^S[1-7] [a-z_]{1,40}$/;

/**
 * `RepairTarget` (the only states `repairWorkItem` can produce: the three W edges a ledger-ahead crash can leave a
 * file behind; `done`, `vetoed` and `cancelled` are not there) was declared in `src/work/types.ts` earlier. The
 * store re-exports it so callers can import it from here.
 */
export type { RepairTarget };

/** The state a repair target is entered from. `awaiting_review -> failed` is deliberately absent. */
const REPAIR_FROM: Readonly<Record<RepairTarget, WorkState>> = {
  in_progress: "ready",
  awaiting_review: "in_progress",
  failed: "in_progress",
};

/**
 * The work item store (spec §11.1), shaped like Symphony's tracker contract: two required reads, one
 * write verb per operation, no generic update. The store writes FILES only. The ledger event for each
 * change is appended by the caller before it calls the verb, because the ledger, not item.md, is
 * authoritative for approval, veto and cancel (verifyItemAgainstLedger, spec §6.2).
 */
export interface StateStore {
  /** [] returns [] without IO. A file-level malformed item.md is skipped, never thrown for. */
  fetchWorkItemsByStates(goalId: string, states: readonly WorkState[]): WorkItem[];
  /** Throws WorkItemError if an id is missing or malformed: an omitted item would change the answer. */
  fetchWorkItemsByIds(workIds: readonly string[]): WorkItem[];
  /** Every readable item of the goal in any state: fingerprint dedupe and aggregates. */
  fetchAllWorkItems(goalId: string): WorkItem[];
  /** Items whose files cannot be read as a work item (the ledger check is verifiedItems' job). */
  malformedItems(goalId: string): { dir: string; work_id: string | null; reason: string }[];
  /** state = risk.class === "high" ? "awaiting_approval" : "ready". Idempotent on the work id. */
  createWorkItem(input: NewWorkItem, now: Date): CreateResult;
  /** human:* only; awaiting_approval -> ready. */
  approveWorkItem(workId: string, actor: string, now: Date): WorkItem;
  /** human:*; any open state -> vetoed. Takes item.lock only, so it succeeds under a live claim. */
  vetoWorkItem(workId: string, actor: string, reason: string, now: Date): WorkItem;
  /** human:* or "omf"; any open state -> cancelled. Takes item.lock only. */
  cancelWorkItem(workId: string, actor: string, now: Date): WorkItem;
  /**
   * The W verbs. OMF's own, so they take no actor: the ledger event the caller appended first is the
   * authority, and the file only catches up to it. All take item.lock only and stamp updated_at = now.
   * No verb can produce `done` (only a person completes an item).
   */
  /** ready -> in_progress. */
  startWorkItem(workId: string, now: Date): WorkItem;
  /** in_progress -> awaiting_review. */
  submitWorkItemForReview(workId: string, now: Date): WorkItem;
  /** in_progress -> failed. Stricter than TRANSITIONS, which also lists awaiting_review -> failed for a person. */
  failWorkItem(workId: string, now: Date): WorkItem;
  /** Only ready -> in_progress, in_progress -> awaiting_review and in_progress -> failed: the file catching up to a ledger that is one W edge ahead. */
  repairWorkItem(workId: string, to: RepairTarget, now: Date): WorkItem;
  /** in_progress only; replaces the progress region with `marker`, which must match PROGRESS_MARKER_PATTERN. */
  setProgressMarker(workId: string, marker: string, now: Date): WorkItem;
}

export function workItemDir(projectDir: string, goalId: string, workId: string): string {
  assertGoalId(goalId);
  assertWorkId(workId);
  return join(projectDir, "goals", goalId, "work", workId);
}

function assertWorkId(workId: string): void {
  if (!WORK_ID_PATTERN.test(workId)) throw new WorkItemError(`invalid work id ${workId}`);
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

/** One line, capped, for a malformed-item reason: parse errors can quote file text. */
function brief(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/\s+/g, " ").slice(0, 200);
}

type Loaded = { ok: true; item: WorkItem } | { ok: false; reason: string };

/** Reads one item directory. The directory name is the identity: a file claiming another id is malformed. */
function load(dir: string, goalId: string, workId: string): Loaded {
  let front: WorkItemFront;
  let progress: string;
  try {
    const parsed = parseWorkItem(readFileSync(join(dir, ITEM_FILE), "utf8"));
    front = validateWorkItem(parsed.front);
    progress = parsed.progress;
  } catch (err) {
    return { ok: false, reason: `item.md unreadable: ${brief(err)}` };
  }
  if (front.work_id !== workId) return { ok: false, reason: "item.md work_id does not match its directory" };
  if (front.goal_id !== goalId) return { ok: false, reason: "item.md goal_id does not match its goal directory" };
  let intent: IntentDoc;
  try {
    intent = parseIntent(readFileSync(join(dir, INTENT_FILE), "utf8"));
  } catch (err) {
    return { ok: false, reason: `intent.md unreadable: ${brief(err)}` };
  }
  if (intent.work_id !== workId) return { ok: false, reason: "intent.md belongs to another work item" };
  return { ok: true, item: { front, dir, progress, intent } };
}

/** Item directories of a goal, sorted. A directory without item.md is not an item (an interrupted create). */
function itemDirNames(projectDir: string, goalId: string): string[] {
  assertGoalId(goalId);
  const root = join(projectDir, "goals", goalId, "work");
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  return entries
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, ITEM_FILE)))
    .map((entry) => entry.name)
    .sort();
}

function loadGoal(
  projectDir: string,
  goalId: string,
): { items: WorkItem[]; malformed: { dir: string; work_id: string | null; reason: string }[] } {
  const items: WorkItem[] = [];
  const malformed: { dir: string; work_id: string | null; reason: string }[] = [];
  for (const name of itemDirNames(projectDir, goalId)) {
    const dir = join(projectDir, "goals", goalId, "work", name);
    if (!WORK_ID_PATTERN.test(name)) {
      malformed.push({ dir, work_id: null, reason: "directory name is not a work id" });
      continue;
    }
    const loaded = load(dir, goalId, name);
    if (loaded.ok) items.push(loaded.item);
    else malformed.push({ dir, work_id: name, reason: loaded.reason });
  }
  return { items, malformed };
}

/** Finds the goal that holds `workId`, or null. */
function locate(projectDir: string, workId: string): { goalId: string; dir: string } | null {
  assertWorkId(workId);
  let goals: string[];
  try {
    goals = readdirSync(join(projectDir, "goals"));
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  for (const goalId of goals.sort()) {
    if (!GOAL_ID_PATTERN.test(goalId)) continue;
    const dir = join(projectDir, "goals", goalId, "work", workId);
    if (existsSync(join(dir, ITEM_FILE))) return { goalId, dir };
  }
  return null;
}

/** The item, null when no goal holds the id; WorkItemError when the files are there but malformed. */
export function findWorkItem(projectDir: string, workId: string): WorkItem | null {
  const located = locate(projectDir, workId);
  if (located === null) return null;
  const loaded = load(located.dir, located.goalId, workId);
  if (!loaded.ok) throw new WorkItemError(`work item ${workId} is malformed: ${loaded.reason}`);
  return loaded.item;
}

function requireHuman(actor: string, verb: string): void {
  if (!/^human:\S+$/.test(actor)) throw new WorkItemError(`${verb} needs a human actor, got ${actor}`);
}

export function createMarkdownStore(projectDir: string): StateStore {
  /**
   * Re-reads the item under item.lock, applies `change` to the front matter and the progress text, validates and
   * rewrites item.md atomically. `progress` must already end in a newline unless it is empty (renderWorkItem's form).
   */
  function mutateItem(
    workId: string,
    change: (item: WorkItem) => { front: WorkItemFront; progress: string },
  ): WorkItem {
    const located = locate(projectDir, workId);
    if (located === null) throw new WorkItemError(`unknown work item ${workId}`);
    return withItemLock(located.dir, () => {
      const loaded = load(located.dir, located.goalId, workId);
      if (!loaded.ok) throw new WorkItemError(`work item ${workId} is malformed: ${loaded.reason}`);
      const next = change(loaded.item);
      const front = validateWorkItem(next.front);
      writePrivateFileAtomic(join(located.dir, ITEM_FILE), renderWorkItem(front, next.progress));
      return { ...loaded.item, front, progress: next.progress };
    });
  }

  /** The common case: change the front matter, keep the progress region as it is. */
  function mutate(workId: string, change: (front: WorkItemFront) => WorkItemFront): WorkItem {
    return mutateItem(workId, (item) => ({ front: change(item.front), progress: item.progress }));
  }

  /** One W edge: the item must be in exactly `from`, and TRANSITIONS must list the edge. */
  function advance(workId: string, from: WorkState, to: WorkState, now: Date): WorkItem {
    return mutate(workId, (front) => {
      if (front.state !== from || !canTransition(from, to)) {
        throw new WorkItemError(`work item ${workId} is ${front.state}; only ${from} items can become ${to}`);
      }
      return { ...front, state: to, updated_at: now.toISOString() };
    });
  }

  function leave(front: WorkItemFront, to: WorkState): void {
    if (!canTransition(front.state, to)) {
      throw new WorkItemError(`work item ${front.work_id} is ${front.state}; it cannot become ${to}`);
    }
  }

  return {
    fetchWorkItemsByStates(goalId, states) {
      if (states.length === 0) return [];
      return loadGoal(projectDir, goalId).items.filter((item) => states.includes(item.front.state));
    },

    fetchWorkItemsByIds(workIds) {
      return workIds.map((workId) => {
        const item = findWorkItem(projectDir, workId);
        if (item === null) throw new WorkItemError(`unknown work item ${workId}`);
        return item;
      });
    },

    fetchAllWorkItems(goalId) {
      return loadGoal(projectDir, goalId).items;
    },

    malformedItems(goalId) {
      return loadGoal(projectDir, goalId).malformed;
    },

    createWorkItem(input, now) {
      const workId = workIdOf(input.fingerprint);
      const dir = workItemDir(projectDir, input.goal_id, workId);
      const stamp = now.toISOString();
      const front = validateWorkItem({
        schema_version: 1,
        work_id: workId,
        goal_id: input.goal_id,
        title: input.candidate.title,
        state: input.risk.class === "high" ? "awaiting_approval" : "ready",
        fingerprint: input.fingerprint,
        risk: input.risk,
        affected_paths: input.candidate.affected_paths,
        has_open_questions: input.candidate.open_questions.length > 0,
        origin: { kind: "reconcile", tick_id: input.tick_id, trigger: input.trigger },
        created_at: stamp,
        updated_at: stamp,
        approval: null,
        veto: null,
      });
      const intent: IntentDoc = {
        goal_id: input.goal_id,
        work_id: workId,
        fingerprint: input.fingerprint,
        candidate: input.candidate,
      };
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      return withItemLock(dir, (): CreateResult => {
        // item.md is written last and its presence means "complete": a crash after intent.md leaves a
        // directory the next create finishes (spec §4.4, work.created is already in the ledger).
        if (existsSync(join(dir, ITEM_FILE))) return { created: false, reason: "exists", work_id: workId };
        writePrivateFileAtomic(join(dir, INTENT_FILE), renderIntent(intent));
        writePrivateFileAtomic(join(dir, ITEM_FILE), renderWorkItem(front, ""));
        return { created: true, item: { front, dir, progress: "", intent } };
      });
    },

    approveWorkItem(workId, actor, now) {
      requireHuman(actor, "approval");
      return mutate(workId, (front) => {
        if (front.state !== "awaiting_approval") {
          throw new WorkItemError(
            `work item ${workId} is ${front.state}; only awaiting_approval items can be approved`,
          );
        }
        const stamp = now.toISOString();
        return { ...front, state: "ready", updated_at: stamp, approval: { approved_by: actor, approved_at: stamp } };
      });
    },

    vetoWorkItem(workId, actor, reason, now) {
      requireHuman(actor, "veto");
      const text = reason.trim();
      if (text.length === 0 || text.length > 500) throw new WorkItemError("veto reason must be 1 to 500 characters");
      return mutate(workId, (front) => {
        leave(front, "vetoed");
        const stamp = now.toISOString();
        return {
          ...front,
          state: "vetoed",
          updated_at: stamp,
          veto: { vetoed_by: actor, vetoed_at: stamp, reason: text },
        };
      });
    },

    cancelWorkItem(workId, actor, now) {
      if (actor !== "omf") requireHuman(actor, "cancel");
      return mutate(workId, (front) => {
        leave(front, "cancelled");
        return { ...front, state: "cancelled", updated_at: now.toISOString() };
      });
    },

    startWorkItem(workId, now) {
      return advance(workId, "ready", "in_progress", now);
    },

    submitWorkItemForReview(workId, now) {
      return advance(workId, "in_progress", "awaiting_review", now);
    },

    failWorkItem(workId, now) {
      return advance(workId, "in_progress", "failed", now);
    },

    repairWorkItem(workId, to, now) {
      // hasOwn first: a `done` or `vetoed` target must be refused by name, never looked up as undefined.
      if (!Object.hasOwn(REPAIR_FROM, to)) throw new WorkItemError(`repair target ${String(to)} is not a W edge`);
      return advance(workId, REPAIR_FROM[to], to, now);
    },

    setProgressMarker(workId, marker, now) {
      if (!PROGRESS_MARKER_PATTERN.test(marker)) {
        throw new WorkItemError("progress marker must be a station S1 to S7 and one lowercase step word");
      }
      return mutateItem(workId, ({ front }) => {
        if (front.state !== "in_progress") {
          throw new WorkItemError(
            `work item ${workId} is ${front.state}; only in_progress items take a progress marker`,
          );
        }
        return { front: { ...front, updated_at: now.toISOString() }, progress: `${marker}\n` };
      });
    },
  };
}
