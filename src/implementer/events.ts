import type { SecretEnvName } from "../container/spec.js";
import type { LedgerEvent, NewEvent } from "../core/ledger.js";
import { validate } from "../core/schema.js";
import type { ImportFailure } from "./import.js";
import type { PlanWhy } from "./plan.js";
import type { ImplementerFailureCode } from "./session.js";

/**
 * Ledger events of the implementer stage (actor `omf`). They record what happened and decide nothing: the W verifier and
 * the fold skip them. Two folds below read them back from the verified ledger, so a restart or a later round cannot change
 * the base commit pinned for an item or the heads it published. Payloads are ids, digests, commit shas, closed codes and
 * counts; no log, plan, note or path text has a field to ride in.
 */

export interface ImplementerScope {
  goal_id: string;
  work_id: string;
  run_id: string;
}

export interface SessionFacts {
  round: number;
  vendor: "claude" | "stub";
  model: string | null;
  outcome: "completed" | ImplementerFailureCode;
  duration_ms: number;
  image_id: string;
  prompt_sha256: string;
  settings_sha256: string;
  log_sha256: string;
  log_bytes: number;
  cost_micro_usd: number | null;
  workspace: "captured" | "incomplete" | "not_captured";
  /** Hits of the credential in the RAW log: informational, a benign `env` call produces them. */
  log_credential_hits: number;
  /** Names only, never values. */
  injected_secret_names: SecretEnvName[];
}

export interface CandidateFacts {
  round: number;
  head_sha: string | null;
  context_sha: string | null;
  commits: number;
  plan: "ok" | "missing" | "not_checked";
  plan_why: PlanWhy | null;
  request: "none" | "raised" | "invalid" | "not_checked";
  scan: "clean" | "credential" | "canary" | "incomplete" | "not_run";
  import_failure: ImportFailure | null;
  published: boolean;
}

type Item = { goal_id: string; work_id: string };
const FOLDED: ReadonlySet<string> = new Set([
  "implementer.base_fixed",
  "implementer.publish_intended",
  "implementer.candidate_checked",
]);

/** Why a payload is not acceptable, or null: the schema first, then the two cross-field rules it cannot state. */
function problemOf(type: string, payload: Record<string, unknown>): string | null {
  const shape = validate("implementer-event.schema.json", { type, payload });
  if (!shape.ok) return `payload fails the schema (${shape.errors})`;
  if (type !== "implementer.candidate_checked") return null;
  const facts = payload as unknown as CandidateFacts;
  if ((facts.plan === "missing") !== (facts.plan_why !== null))
    return "plan_why must be set exactly when the plan is missing";
  if (facts.published && (facts.head_sha === null || facts.scan !== "clean" || facts.import_failure !== null)) {
    return "a published candidate needs a head, a clean scan and no import failure";
  }
  return null;
}

/** A malformed payload fails here, at the writer, instead of becoming a ledger event a fold must distrust. */
function build(type: string, scope: ImplementerScope, facts: object): NewEvent {
  const payload = { goal_id: scope.goal_id, work_id: scope.work_id, run_id: scope.run_id, ...facts };
  const problem = problemOf(type, payload);
  if (problem !== null) throw new Error(`invalid ${type} event: ${problem}`);
  return { actor: "omf", type, payload };
}

/** Once per item: the commit of the user's repository the work is based on, and its tree. The first valid one wins. */
export const baseFixedEvent = (scope: ImplementerScope, facts: { base_sha: string; base_tree_sha: string }): NewEvent =>
  build("implementer.base_fixed", scope, facts);

export const sessionCompletedEvent = (scope: ImplementerScope, facts: SessionFacts): NewEvent =>
  build("implementer.session_completed", scope, { ...facts, injected_secret_names: [...facts.injected_secret_names] });

/** Written BEFORE `update-ref`: a crash between the ref update and `candidate_checked` leaves an intended head the next round still recognises. */
export const publishIntendedEvent = (scope: ImplementerScope, facts: { round: number; head_sha: string }): NewEvent =>
  build("implementer.publish_intended", scope, facts);

export const candidateCheckedEvent = (scope: ImplementerScope, facts: CandidateFacts): NewEvent =>
  build("implementer.candidate_checked", scope, facts);

/** The item's folded events of actor omf that pass the same checks the writer applies; a forged actor or a foreign item is skipped. */
function ownEvents(events: readonly LedgerEvent[], item: Item): LedgerEvent[] {
  return events.filter(
    (event) =>
      event.actor === "omf" &&
      FOLDED.has(event.type) &&
      event.payload.goal_id === item.goal_id &&
      event.payload.work_id === item.work_id &&
      problemOf(event.type, event.payload) === null,
  );
}

/** The first schema-valid `implementer.base_fixed` of actor omf for the item; null when none. */
export function baseFixedOf(
  events: readonly LedgerEvent[],
  item: Item,
): { base_sha: string; base_tree_sha: string } | null {
  const first = ownEvents(events, item).find((event) => event.type === "implementer.base_fixed");
  return first === undefined
    ? null
    : { base_sha: first.payload.base_sha as string, base_tree_sha: first.payload.base_tree_sha as string };
}

/** Heads this item published or intended to publish, oldest first, each once: the only values `refs/heads/omf/<work-id>` may hold. */
export function publishedHeads(events: readonly LedgerEvent[], item: Item): string[] {
  const heads: string[] = [];
  for (const event of ownEvents(events, item)) {
    const counts = event.type === "implementer.publish_intended" || event.payload.published === true;
    const head = event.payload.head_sha;
    if (counts && typeof head === "string" && !heads.includes(head)) heads.push(head);
  }
  return heads;
}
