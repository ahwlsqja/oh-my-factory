import type { LedgerEvent, NewEvent } from "../core/ledger.js";
import { validate } from "../core/schema.js";
import { DECISION_CLASSES } from "../decision/types.js";
import { scorePct } from "./ladder.js";
import { FeedbackError, type ReleasedCategory } from "./types.js";

/**
 * Ledger events of the feedback channel (spec §4.4 step 4, §5.7). They are the only persistent state of the
 * Ladder, of the per-work-item exposure count and of the test split: nothing is cached, every reader folds the
 * verified ledger, so a restart cannot change a count (M3d-D6, D10, D11). Payloads are ids, digests, commit
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
  // consumed_test_digest null: a J3 act with no test run consumed yet; it only restarts the exposure count (M3d-D10).
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
 * Scoped like budgetStateFromEvents (M3d-D9): an event of another goal, an unknown `feedback.*` type name, or a
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
