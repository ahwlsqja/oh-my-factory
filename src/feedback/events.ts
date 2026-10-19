import type { LedgerEvent, NewEvent } from "../core/ledger.js";
import { validate } from "../core/schema.js";
import { DECISION_CLASSES, type DecisionClass } from "../decision/types.js";
import { type BestEntry, meetsMargin, scorePct } from "./ladder.js";
import { FeedbackError, type ReleasedCategory } from "./types.js";

/**
 * Ledger events of the feedback channel (spec §4.4 step 4, §5.7). They are the only persistent state of the
 * Ladder, of the per-work-item exposure count and of the test split: nothing is cached, every reader folds the
 * verified ledger, so a restart cannot change a count. Payloads are ids, digests, commit
 * shas, enum members and counts; a scenario id or text has no field to ride in.
 */

export const FEEDBACK_EVENT_TYPES = [
  "feedback.released",
  "feedback.test_run_consumed",
  "feedback.test_run_completed",
  "feedback.test_reseal_authorized",
] as const;
export type FeedbackEventType = (typeof FEEDBACK_EVENT_TYPES)[number];

interface Scope {
  goal_id: string;
  work_id: string;
}

export type FeedbackEvent =
  | {
      type: "feedback.released";
      payload: Scope & {
        run_id: string;
        train_digest: string;
        round: number;
        // Carries `pass` so the fold can re-check the Ladder exactly; the renderer never prints it.
        categories: ReleasedCategory[];
        disclosure_units: 0 | 1;
      };
    }
  | {
      type: "feedback.test_run_consumed";
      payload: Scope & { run_id: string; test_digest: string; candidate_sha: string; test_total: number };
    }
  | {
      type: "feedback.test_run_completed";
      payload: Scope & {
        run_id: string;
        test_digest: string;
        candidate_sha: string;
        pass: number;
        total: number;
        flaky: number;
      };
    }
  // consumed_test_digest null: a J3 act with no test run consumed yet; it only restarts the exposure count.
  | {
      type: "feedback.test_reseal_authorized";
      payload: Scope & { consumed_test_digest: string | null; basis: "J3" | "J6" };
    };

export type ClassifiedFeedback =
  | { kind: "none" }
  | { kind: "feedback"; seq: number; actor: string; event: FeedbackEvent };
export type FeedbackRecord = Extract<ClassifiedFeedback, { kind: "feedback" }>;

const TYPE_SET: ReadonlySet<string> = new Set(FEEDBACK_EVENT_TYPES);

/** The reseal authorization is a person's act (J3/J6); everything else is written by omf itself. */
function actorAllowed(type: string, actor: string): boolean {
  return type === "feedback.test_reseal_authorized" ? actor.startsWith("human:") : actor === "omf";
}

function releasedProblem(payload: Extract<FeedbackEvent, { type: "feedback.released" }>["payload"]): string | null {
  let previous = -1;
  let anyScore = false;
  for (const [index, c] of payload.categories.entries()) {
    const order = DECISION_CLASSES.indexOf(c.category);
    if (order <= previous) return `categories are not unique and in class order at index ${index}`;
    previous = order;
    if (c.pass > c.n) return `pass is above n at index ${index}`;
    if (c.score_pct !== scorePct(c.pass, c.n)) return `score_pct does not match pass and n at index ${index}`;
    if (c.kind !== "repeat") anyScore = true;
  }
  if ((payload.disclosure_units === 1) !== anyScore) return "disclosure_units does not match the kinds";
  return null;
}

/**
 * Why a payload is not acceptable, or null. Schema first, then the cross-field rules the schema cannot state.
 * The text holds ajv's rule messages (which never echo data) and fixed phrases, never a payload value.
 */
function problemOf(type: string, payload: Record<string, unknown>): string | null {
  const shape = validate("feedback-event.schema.json", { type, payload });
  if (!shape.ok) return `payload fails the schema (${shape.errors})`;
  const event = { type, payload } as unknown as FeedbackEvent;
  if (event.type === "feedback.released") return releasedProblem(event.payload);
  if (event.type === "feedback.test_run_completed") {
    const { pass, total, flaky } = event.payload;
    if (pass > total) return "pass is above total";
    if (flaky > total - pass) return "flaky is above total minus pass";
  }
  return null;
}

function invalidEvent(type: string, seq: number, why: string): FeedbackError {
  return new FeedbackError("invalid_event", `invalid ${type} at seq ${seq}: ${why}`);
}

/**
 * The event as OMF or a person appends it. The actor is checked first (`forbidden`), then the payload
 * (`invalid_input`), so a malformed or mis-attributed event fails here, at the writer, instead of becoming a
 * ledger event that stops the goal's line later.
 */
export function feedbackEvent(event: FeedbackEvent, actor: string): NewEvent {
  if (!actorAllowed(event.type, actor)) {
    throw new FeedbackError("forbidden", `${event.type} cannot be written by this actor`);
  }
  const payload = structuredClone(event.payload) as unknown as Record<string, unknown>;
  const problem = problemOf(event.type, payload);
  if (problem !== null) throw new FeedbackError("invalid_input", `invalid ${event.type}: ${problem}`);
  return { actor, type: event.type, payload };
}

/**
 * Every feedback event of one goal, in ledger order, each fully re-checked (actor, schema, per-event rules).
 * Scoped like budgetStateFromEvents: an event of another goal, an unknown `feedback.*` type name, or a
 * payload whose goal_id is not a string equal to `goalId` belongs to nobody here and is skipped, so one goal's
 * bad event cannot stop every goal's feedback on a ledger that has no repair path. A bad event of THIS goal
 * throws `invalid_event`: skipping it would silently reset the Ladder or the exposure count.
 */
export function feedbackEventsOf(events: readonly LedgerEvent[], goalId: string): FeedbackRecord[] {
  const found: FeedbackRecord[] = [];
  for (const event of events) {
    if (!TYPE_SET.has(event.type) || event.payload.goal_id !== goalId) continue;
    if (!actorAllowed(event.type, event.actor)) throw invalidEvent(event.type, event.seq, "written by the wrong actor");
    const problem = problemOf(event.type, event.payload);
    if (problem !== null) throw invalidEvent(event.type, event.seq, problem);
    found.push({
      kind: "feedback",
      seq: event.seq,
      actor: event.actor,
      event: { type: event.type, payload: event.payload } as unknown as FeedbackEvent,
    });
  }
  return found;
}

export interface LadderState {
  best: Map<DecisionClass, BestEntry>;
  releases: number;
  layout: { work_id: string; categories: { category: DecisionClass; n: number }[] } | null;
}

/**
 * The Ladder of one (goal, train set digest), folded from the verified ledger (spec §5.7). Nothing
 * is cached, so a restart or a new work item cannot reset it. The fold re-derives every claim a release event
 * makes instead of trusting it, because a forged event could raise or lower the baseline:
 * - round == previous round + 1;
 * - every release of one digest has the same work_id, category set and n per category (the layout; the digest
 *   alone does not pin it, so a changed layout is a bug or a forgery);
 * - kind "first" iff the category has no best yet, "new" iff meetsMargin(pass - best.pass, n), "repeat" iff
 *   pass == best.pass (the Ladder never shows a decrease);
 * - a release with disclosure_units 1 is immediately preceded (seq - 1) by its own omf budget.consumed of one
 *   disclosure unit for this goal, so a unit cannot be spent without a release or shared by two.
 * Per-event rules (pass <= n, score_pct, class order, units match kinds) are already checked by
 * feedbackEventsOf. Any breach throws FeedbackError("invalid_event") and stops the line.
 */
export function ladderStateFromEvents(
  events: readonly LedgerEvent[],
  goalId: string,
  trainDigest: string,
): LadderState {
  const bySeq = new Map<number, LedgerEvent>(events.map((event) => [event.seq, event]));
  const state: LadderState = { best: new Map(), releases: 0, layout: null };
  for (const record of feedbackEventsOf(events, goalId)) {
    const event = record.event;
    if (event.type !== "feedback.released" || event.payload.train_digest !== trainDigest) continue;
    const { payload } = event;
    const fail = (why: string): FeedbackError => invalidEvent(event.type, record.seq, why);
    if (payload.round !== state.releases + 1) throw fail("round is not the previous round plus one");
    const layout = {
      work_id: payload.work_id,
      categories: payload.categories.map(({ category, n }) => ({ category, n })),
    };
    if (state.layout !== null && JSON.stringify(state.layout) !== JSON.stringify(layout)) {
      throw fail("work item, category set or n differs from the first release of this digest");
    }
    state.layout ??= layout;
    for (const c of payload.categories) {
      const best = state.best.get(c.category);
      if (best === undefined) {
        if (c.kind !== "first") throw fail(`${c.category} has no best yet but its kind is ${c.kind}`);
        state.best.set(c.category, { pass: c.pass, n: c.n });
      } else if (c.kind === "new") {
        if (!meetsMargin(c.pass - best.pass, c.n)) throw fail(`${c.category} is new but gains less than the margin`);
        state.best.set(c.category, { pass: c.pass, n: c.n });
      } else if (c.kind !== "repeat" || c.pass !== best.pass) {
        throw fail(`${c.category} kind ${c.kind} does not follow from the best released score`);
      }
    }
    if (payload.disclosure_units === 1) {
      const before = bySeq.get(record.seq - 1);
      const paid =
        before !== undefined &&
        before.type === "budget.consumed" &&
        before.actor === "omf" &&
        before.payload.goal_id === goalId &&
        before.payload.kind === "disclosure" &&
        before.payload.amount === 1;
      if (!paid) throw fail("a new score is not immediately preceded by its disclosure unit");
    }
    state.releases += 1;
  }
  return state;
}

/**
 * Per-scenario exposure (spec 437, limit 20) as the ledger sees it: the number of releases that
 * showed a new score (disclosure_units 1) for (goal, work item), over EVERY train digest of the item, counted
 * since the latest J3 reseal authorization for it. Every train scenario contributes to every release, so one
 * count covers them all. It is not keyed by digest: a digest changes whenever any scenario is added, retired or
 * contaminated, and a per-digest count would then restart for every surviving scenario, so the limit could be
 * evaded without a person. Only a J3 act (fresh scenarios) restarts it; J6 (a raised budget) does not.
 */
export function exposureUnitsOf(events: readonly LedgerEvent[], goalId: string, workId: string): number {
  let units = 0;
  for (const record of feedbackEventsOf(events, goalId)) {
    const event = record.event;
    if (event.payload.work_id !== workId) continue;
    if (event.type === "feedback.test_reseal_authorized" && event.payload.basis === "J3") units = 0;
    else if (event.type === "feedback.released" && event.payload.disclosure_units === 1) units += 1;
  }
  return units;
}

/**
 * The shape of the `ExposureCount` of `src/scenario/gate2.ts` (`({split, digest}) => number`), written structurally so this
 * file needs no import from it; a wider `split` parameter is assignable to its narrower one. There is no `reserveExposure`
 * or `scenario.exposed`: GATE-2's `exposure_exhausted` calls the function supplied here.
 */
export type ExposureCountFn = (key: { split: string; digest: string }) => number;

/**
 * The `ExposureCount` the feedback layer supplies to GATE-2: the (goal, work item) count of `exposureUnitsOf`, returned for ANY split
 * and digest key (the count is not keyed by digest). A snapshot of the events passed in; the caller builds a new
 * function after the ledger changes.
 */
export function exposureCountFor(events: readonly LedgerEvent[], goalId: string, workId: string): ExposureCountFn {
  const units = exposureUnitsOf(events, goalId, workId);
  return () => units;
}
