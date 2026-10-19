import type { NewEvent } from "../core/ledger.js";
import { validate } from "../core/schema.js";
import type { DecisionScope } from "../decision/types.js";
import type { AuthorFailureCode } from "../scenario/types.js";

/**
 * The ledger event of one container author run (actor `omf`, spec §5.3). It records that a run happened and how it
 * ended and decides nothing: the W verifier and the fold skip it. The payload is ids, digests, closed codes and counts;
 * the prompt, the answer, the logs and the key have no field to ride in. The secret appears by name only.
 */
export interface AuthorSessionFacts {
  /** The seal pass's run-shaped id; also the container label `run_id`. */
  pass_id: string;
  round: number;
  vendor: "codex";
  /** `roles.author.model`, or the constant `codex-default` when the config names none. */
  model: string;
  outcome: "completed" | AuthorFailureCode;
  duration_ms: number;
  image_id: string;
  /** sha256 of the whole stdin of the Codex exec: the prompt plus the answer-envelope suffix. */
  input_sha256: string;
  /** Non-empty exactly when the outcome is `not_golden`: what the measurement found. */
  violation_codes: string[];
  /** sha256 of `answer.json`; null when no answer was read or it was dropped. */
  answer_sha256: string | null;
  answer_bytes: number;
  /** Bytes Codex printed on stdout and stderr in the call; 0 when it never ran. */
  output_bytes: number;
  /** The caps in force for this call: wall time and output bytes of the call, and calls per work item. */
  limit_timeout_ms: number;
  limit_output_bytes: number;
  limit_calls: number;
  /** Author calls this work item had recorded before this one. */
  calls_before: number;
  /** Occurrences of the key in the exec output and the answer. Counted, never stored. */
  credential_hits: number;
  injected_secret_names: ["CODEX_API_KEY"];
}

export const AUTHOR_SESSION_EVENT = "author.session_completed";

/** A malformed payload fails here, at the writer, instead of becoming a ledger event a fold must distrust. */
export function authorSessionCompletedEvent(scope: DecisionScope, facts: AuthorSessionFacts): NewEvent {
  const payload = {
    goal_id: scope.goal_id,
    work_id: scope.work_id,
    ...facts,
    violation_codes: [...facts.violation_codes],
    injected_secret_names: [...facts.injected_secret_names],
  };
  const shape = validate("author-event.schema.json", { type: AUTHOR_SESSION_EVENT, payload });
  if (!shape.ok) throw new Error(`invalid ${AUTHOR_SESSION_EVENT} event: payload fails the schema (${shape.errors})`);
  if ((facts.outcome === "not_golden") !== facts.violation_codes.length > 0) {
    throw new Error(
      `invalid ${AUTHOR_SESSION_EVENT} event: violation_codes must be non-empty exactly when the outcome is not_golden`,
    );
  }
  return { actor: "omf", type: AUTHOR_SESSION_EVENT, payload };
}

export const AUTHOR_STARTED_EVENT = "author.session_started";

/** What is known when a pass takes its call, before any container exists. */
export interface AuthorSessionStart {
  pass_id: string;
  round: number;
  /** Calls this work item had counted before this one. */
  calls_before: number;
  limit_calls: number;
}

/**
 * Appended under `seal.lock` before the first `docker create` of a pass. It is the record the call cap counts, so a host
 * killed during the call, or a throw before the completed event, still spends the call.
 */
export function authorSessionStartedEvent(scope: DecisionScope, start: AuthorSessionStart): NewEvent {
  const payload = { goal_id: scope.goal_id, work_id: scope.work_id, ...start };
  const shape = validate("author-start-event.schema.json", { type: AUTHOR_STARTED_EVENT, payload });
  if (!shape.ok) throw new Error(`invalid ${AUTHOR_STARTED_EVENT} event: payload fails the schema (${shape.errors})`);
  return { actor: "omf", type: AUTHOR_STARTED_EVENT, payload };
}
