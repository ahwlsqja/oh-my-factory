import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { PROGRESS_MARKER_PATTERN } from "../adapters/state-markdown.js";
import type { LedgerEvent } from "../core/ledger.js";
import { writePrivateFileAtomic } from "../core/private-fs.js";
import { validate } from "../core/schema.js";
import type { Classification } from "./classify.js";
import { LINE_ORDER, type NodeId, type UnverifiedCode } from "./line-types.js";
import { classifyWEvent, lastStateEvent, type ReasonCode, RUN_ID_PATTERN } from "./w-events.js";

/**
 * The minimal handoff record (spec §6.3, M3b2-D10, D21): what a person needs when a run stops without a
 * result they can merge, or when a run died. Everything in it is an id, a closed code or a fixed sentence
 * written in this file, so no model text and no metric id can reach it (the same rule as the ledger events).
 * The full packet and `omf answer` are M4; `resume` is the placeholder for them.
 */

export type JCode = "J2" | "J3" | "J4" | "J6" | "J7" | "J8";
export type HandoffKind = "outcome" | "killed_predecessor";

export interface HandoffRecord {
  schema_version: 1;
  kind: HandoffKind;
  work_id: string;
  goal_id: string;
  /** The run that wrote the record. */
  run_id: string;
  /** killed_predecessor: seq of the work.claim_reclaimed event it covers; outcome: null. */
  predecessor_seq: number | null;
  outcome: "flawed" | "blocked" | "manual";
  reason_code: ReasonCode;
  /** The route's fixed sentence plus the next node in line. */
  state: string;
  ran: { node: NodeId; result: string }[];
  remaining: NodeId[];
  risks: UnverifiedCode[];
  decision_required: { j: JCode; question: string; options: string[] };
  /** Placeholder for `omf answer <request-id>` (M4). */
  resume: "not_available_until_m4";
  created_at: string;
}

interface Route {
  j: JCode;
  state: string;
  question: string;
  options: (workId: string, goalId: string) => string[];
}

// The only commands an option may name. Each exists today. `omf run` runs the line again on a sealed item and
// `omf seal` seals or reseals it, so an option names `omf seal` only where the seal is what is missing.
// `omf cancel` is absent on purpose: no such command exists for a work item, and `omf veto` ends an open item
// from any state.
const show = (id: string): string => `omf work show ${id}`;
const decideShow = (id: string): string => `omf decide show ${id}`;
const decideResolve = (id: string): string => `omf decide resolve ${id} <decision_id> --file <resolution.json>`;
const veto = (id: string): string => `omf veto ${id}`;
const raiseRounds = (id: string): string => `omf budget raise ${id} --rounds <n>`;
const raiseUsd = (id: string): string => `omf budget raise ${id} --usd <amount>`;
const rerun = (id: string): string => `omf run ${id}`;
const reseal = (id: string): string => `omf seal ${id}`;
// The disclosure budget belongs to the goal, so these two name the goal id and not the work id.
const declareDisclosure = (goalId: string): string => `omf budget declare ${goalId} disclosure <n>`;
const raiseDisclosure = (goalId: string): string => `omf budget raise ${goalId} disclosure <n>`;

const REVIEW_QUESTION = "Do you accept this result after reading its evidence, or drop the item?";
const RETRY_QUESTION = "Should the line be tried again, the item changed, or the item dropped?";
const review = (id: string): string[] => [show(id), veto(id)];
const retry = (id: string): string[] => [show(id), veto(id), rerun(id)];

/**
 * Reason code -> the J act that answers it (breakdown M3b2, spec §6.3). `Record<ReasonCode, ...>` makes a
 * new reason code a compile error until it has a route. J6 is "the line cannot go on by itself", J7 "a gate
 * or a step needs a person", J8 "a limit a person can raise".
 */
export const HANDOFF_ROUTES: Readonly<Record<ReasonCode, Route>> = {
  j2_open: {
    j: "J2",
    state: "A design question of this item is still open, so the line stopped before any work started.",
    question: "Which answer do you give to the open design question?",
    options: (id) => [decideShow(id), decideResolve(id), veto(id), reseal(id)],
  },
  gate2_exhausted: {
    j: "J3",
    state: "The sealed-scenario loop used all its visits before any implementation started.",
    question: "Should the scenarios be reworked, or should the item be dropped?",
    options: (id) => [show(id), veto(id), reseal(id)],
  },
  scenarios_need_review: {
    j: "J3",
    state: "The sealed scenarios, or what they were written from, need a person before the line can go on.",
    question:
      "The line cannot go on with these scenarios, because a rerun reuses the standing seal. Should the item be dropped?",
    options: review,
  },
  audit_flag: {
    j: "J4",
    state: "The audit flagged the result, so it is not recommended.",
    question: REVIEW_QUESTION,
    options: review,
  },
  sealed_failed: {
    j: "J4",
    state: "A sealed scenario failed, so the result is not recommended.",
    question: REVIEW_QUESTION,
    options: review,
  },
  flaky_scenario: {
    j: "J4",
    state: "A sealed scenario was flaky, so the result is not recommended.",
    question: REVIEW_QUESTION,
    options: review,
  },
  within_variance: {
    j: "J4",
    state: "The measured gain is within run-to-run variance, so the result is not recommended.",
    question: REVIEW_QUESTION,
    options: review,
  },
  budget_exhausted: {
    j: "J8",
    state: "The per-item round or spend limit is used up, so the item is parked.",
    question: "Should the limit be raised, or should the item be dropped?",
    options: (id) => [raiseRounds(id), raiseUsd(id), veto(id), rerun(id)],
  },
  gate_blocked: {
    j: "J7",
    state: "A gate or the budget record blocked the line and needs a person to look.",
    question: "What should happen to this item?",
    options: retry,
  },
  manual_required: {
    j: "J7",
    state: "A station asked for a step that a person has to do by hand.",
    question: "Will you do the manual step, or drop the item?",
    options: retry,
  },
  run_killed: {
    j: "J6",
    state: "A previous run was killed before it finished and its claim was reclaimed.",
    question: RETRY_QUESTION,
    options: retry,
  },
  visit_cap: {
    j: "J6",
    state: "A station or gate used more visits than its cap in one round.",
    question: RETRY_QUESTION,
    options: retry,
  },
  stalled: {
    j: "J6",
    state: "A rework round changed nothing compared with the round before.",
    question: RETRY_QUESTION,
    options: retry,
  },
  reentry_loop: {
    j: "J6",
    state: "The same blocker or a kill repeated three times since the last human act.",
    question: RETRY_QUESTION,
    options: retry,
  },
  gate_not_run: {
    j: "J6",
    state: "A required gate did not run or has no implementation yet, so the line failed closed.",
    question: RETRY_QUESTION,
    options: retry,
  },
  station_error: {
    j: "J6",
    state: "A station failed with an error.",
    question: RETRY_QUESTION,
    options: retry,
  },
  station_skipped: {
    j: "J6",
    state: "A required station was skipped, so the line failed closed.",
    question: RETRY_QUESTION,
    options: retry,
  },
  evidence_incomplete: {
    j: "J6",
    state: "A required input of the evidence was never produced, so the line failed closed.",
    question: RETRY_QUESTION,
    options: retry,
  },
  infra_failure: {
    j: "J6",
    state: "An infrastructure fault stopped a station.",
    question: RETRY_QUESTION,
    options: retry,
  },
  test_run_incomplete: {
    j: "J6",
    state: "The sealed test split was consumed by an earlier run that never recorded a result.",
    question:
      "The line cannot go on: a rerun reuses the standing seal and meets the same used test split. Should the item be dropped?",
    options: review,
  },
  test_reseal_required: {
    j: "J3",
    state: "The sealed test split was already used for different code and needs a fresh split from a person.",
    question:
      "The line cannot go on: a rerun reuses the standing seal, and a fresh test split needs a person's authorization, which has no command yet. Should the item be dropped?",
    options: review,
  },
  noise_unverified: {
    j: "J4",
    state: "The run passed, but with fewer than two repetitions its result cannot be shown to be stable.",
    question: REVIEW_QUESTION,
    options: review,
  },
  scenarios_exhausted: {
    j: "J3",
    state:
      "The sealed scenarios cannot give more feedback because they are too few or their exposure limit is reached.",
    question:
      "The line cannot go on: a rerun reuses the standing seal and would stop here again, and no command seals fresh scenarios yet. Should the item be dropped?",
    options: review,
  },
  gates_failed: {
    j: "J4",
    state: "A declared gate failed, so the result is not recommended.",
    question: REVIEW_QUESTION,
    options: review,
  },
  disclosure_unavailable: {
    j: "J8",
    state: "Feedback needs a disclosure budget, and none is declared or the declared one is used up.",
    question: "Should a disclosure budget be declared or raised, or should the item be dropped?",
    options: (id, goalId) => [declareDisclosure(goalId), raiseDisclosure(goalId), veto(id), rerun(id)],
  },
  plan_missing: {
    j: "J4",
    state: "The implementer did not commit a plan first, so the result is not recommended.",
    question: REVIEW_QUESTION,
    options: review,
  },
  // A rerun is real here: the next S3 clears the persisted request and starts again, and `beginRun` refuses only manual items.
  implementer_request: {
    j: "J2",
    state:
      "The implementer asked a person to settle a conflict between a test and the spec, so the line stopped before judging.",
    question: "Which answer do you give to the implementer's request?",
    options: (id) => [decideShow(id), veto(id), rerun(id)],
  },
};

/**
 * The `ran` list of a run that left a progress marker (`S3 working`). The marker grammar is closed
 * (PROGRESS_MARKER_PATTERN), so a match is two closed words; anything else, including null, yields none.
 * Task 9 passes the marker only for a resumed item: a marker left by an earlier parked run is not this run's.
 */
export function markerToRan(marker: string | null): HandoffRecord["ran"] {
  const text = (marker ?? "").trim();
  if (!PROGRESS_MARKER_PATTERN.test(text)) return [];
  const [node, result] = text.split(" ");
  return [{ node: node as NodeId, result: result as string }];
}

/** The nodes after `last` in the one legal line order; the whole line when nothing ran. */
export function remainingAfter(last: NodeId | null): NodeId[] {
  if (last === null) return [...LINE_ORDER];
  const at = LINE_ORDER.indexOf(last);
  return at < 0 ? [] : LINE_ORDER.slice(at + 1);
}

export interface HandoffInput {
  kind: HandoffKind;
  scope: { work_id: string; goal_id: string; run_id: string };
  /** killed_predecessor: the seq of the work.claim_reclaimed event covered; outcome: null. */
  predecessor_seq: number | null;
  classification: Pick<Classification, "outcome" | "reason_code" | "unverified_areas">;
  ran: HandoffRecord["ran"];
  remaining: NodeId[];
  now: Date;
}

/**
 * Builds the record and checks it against `handoff.schema.json` before returning, so a free-form `result`, an
 * unknown node or a kind that does not fit its predecessor seq never leaves this function. `risks` keeps the
 * codes of the unverified areas and drops their decision ids (an id is not needed to find the evidence).
 */
export function buildHandoff(input: HandoffInput): HandoffRecord {
  const { outcome, reason_code, unverified_areas } = input.classification;
  if (outcome === "success" || reason_code === null) {
    throw new Error("a handoff needs a flawed, blocked or manual outcome with a reason code");
  }
  const route = HANDOFF_ROUTES[reason_code];
  const next = input.remaining[0];
  const record: HandoffRecord = {
    schema_version: 1,
    kind: input.kind,
    work_id: input.scope.work_id,
    goal_id: input.scope.goal_id,
    run_id: input.scope.run_id,
    predecessor_seq: input.predecessor_seq,
    outcome,
    reason_code,
    state: next === undefined ? route.state : `${route.state} Next in line: ${next}.`,
    ran: input.ran,
    remaining: input.remaining,
    risks: [...new Set(unverified_areas.map((area) => area.code))],
    decision_required: {
      j: route.j,
      question: route.question,
      options: route.options(input.scope.work_id, input.scope.goal_id),
    },
    resume: "not_available_until_m4",
    created_at: input.now.toISOString(),
  };
  const check = validate("handoff.schema.json", record);
  if (!check.ok) throw new Error(`invalid handoff: ${check.errors}`);
  return record;
}

const HANDOFF_DIR = "handoffs";

/** `handoffs/<run_id>.json` or `handoffs/<run_id>.predecessor.json` under the item directory. */
export function handoffFile(itemDir: string, runId: string, kind: HandoffKind): string {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error("handoff file names need a run id");
  return join(itemDir, HANDOFF_DIR, `${runId}${kind === "outcome" ? "" : ".predecessor"}.json`);
}

/**
 * Atomic (temp file, then rename), 0600, parents 0700. History is never overwritten: a second record for the
 * same run and kind is refused. Only the run that holds the item's claim writes, so the existence check
 * cannot race with another writer of the same name.
 */
export function writeHandoff(itemDir: string, record: HandoffRecord): void {
  const check = validate("handoff.schema.json", record);
  if (!check.ok) throw new Error(`invalid handoff: ${check.errors}`);
  const path = handoffFile(itemDir, record.run_id, record.kind);
  if (existsSync(path))
    throw new Error(`handoff ${basename(path)} already exists; handoffs are history and are never overwritten`);
  writePrivateFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
}

const PREDECESSOR_FILE = /^r-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{4}\.predecessor\.json$/;

/** The highest `predecessor_seq` any valid killed_predecessor file of the item holds; 0 when there is none. A corrupt file covers nothing. */
function coveredUpTo(itemDir: string): number {
  let names: string[];
  try {
    names = readdirSync(join(itemDir, HANDOFF_DIR));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  let covered = 0;
  for (const name of names) {
    if (!PREDECESSOR_FILE.test(name)) continue;
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(join(itemDir, HANDOFF_DIR, name), "utf8"));
    } catch {
      continue;
    }
    if (!validate("handoff.schema.json", doc).ok) continue;
    const seq = (doc as HandoffRecord).predecessor_seq;
    if ((doc as HandoffRecord).kind === "killed_predecessor" && seq !== null) covered = Math.max(covered, seq);
  }
  return covered;
}

/**
 * Which killed run still owes a handoff (M3b2-D21), read from the ledger and not from `run.reclaimed`: a reclaim
 * done by `repairGoal` during another item's entry leaves `run.reclaimed` null for the run that finds it later.
 * A `work.claim_reclaimed` after the item's last state event is owed until a predecessor file with a
 * `predecessor_seq` at or above its seq exists. The payload names the run that reclaimed, not the killed one, so
 * the seq is the only handle. At most one entry comes back, the newest: one file covers every older reclaim,
 * and a file name carries one run id, so two files from one run could not exist.
 */
export function owedPredecessors(itemDir: string, events: readonly LedgerEvent[], workId: string): { seq: number }[] {
  const last = lastStateEvent(events, workId);
  const floor = last === null ? 0 : last.seq;
  let newest = 0;
  for (const event of events) {
    if (event.seq <= floor) continue;
    const classified = classifyWEvent(event);
    if (classified.kind !== "w") continue;
    const w = classified.event;
    if (w.type === "work.claim_reclaimed" && w.payload.work_id === workId) newest = Math.max(newest, event.seq);
  }
  if (newest === 0 || coveredUpTo(itemDir) >= newest) return [];
  return [{ seq: newest }];
}
