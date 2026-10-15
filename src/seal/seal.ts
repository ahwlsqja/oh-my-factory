import { join } from "node:path";
import { sha256Hex } from "../core/canonical-json.js";
import type { Ledger, NewEvent } from "../core/ledger.js";
import { LockHeldError, acquireLock, releaseLock } from "../core/lock.js";
import type { ProjectLocation } from "../core/paths.js";
import { assertStateTreeClean } from "../core/safe-fs.js";
import { validateDef } from "../core/schema.js";
import { type Gate1Reason, evaluateGate1, intentQuestionIds } from "../decision/gate1.js";
import { loadLeakContext } from "../decision/leak-lint.js";
import { decisionsDigest, foldDecisions } from "../decision/state.js";
import type { DecisionScope } from "../decision/types.js";
import {
  type SealCounts,
  type SealFailureCode,
  type SealRecord,
  WORK_STARTED_EVENT,
  authorPrecedesStart,
  foldSeals,
} from "../scenario/events.js";
import { type Ids, intakeAuthored } from "../scenario/intake.js";
import type { AuthorStamp, SealFeedback } from "../scenario/types.js";
import { assertNoSealedInRepo } from "../vault/pokayoke.js";
import { type Vault, writeScenarioSet } from "../vault/vault.js";
import type { WorkItem } from "../work/types.js";
import { SealInputError, type SealInputErrorCode, buildSealPrompt, sealInputsFor } from "./prompt.js";
import { type AgentSession, DEFAULT_AUTHOR_TIMEOUT_MS } from "./session.js";

export interface SealDeps {
  location: ProjectLocation;
  item: WorkItem;
  session: AgentSession;
  ledger: Ledger;
  vault: Vault;
  now: () => Date;
  ids: Ids;
  timeoutMs?: number;
  feedback?: SealFeedback;
  /** The state root is resolved from this, like `Gate2Context.env`; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Default: `assertStateTreeClean` then `assertNoSealedInRepo`. A throw ends the stage before anything else happens. */
  preflight?: () => void;
}

export type SealStageResult =
  // "stored", not "sealed": a host stub author is unmeasured (M3c-D11).
  | { status: "stored"; round: number; seal_id: string; set_sha256: string; counts: SealCounts; author: AuthorStamp }
  // work.started exists and the author preceded it: the latest seal stands (a restart after a killed run).
  | { status: "reused"; seal: SealRecord }
  | { status: "blocked_gate1"; reasons: Gate1Reason[] }
  | { status: "blocked_input"; code: SealInputErrorCode }
  | { status: "refused"; reason: "implementation_started" | "seal_in_progress" }
  | { status: "failed"; code: SealFailureCode };

/**
 * `<item dir>/seal.lock`. Not `item.lock`: that one is a millisecond mutex with a 2 s wait, and an author runs for
 * minutes, so holding it would make a person's veto fail with a lock timeout.
 */
export function sealLockFile(itemDir: string): string {
  return join(itemDir, "seal.lock");
}

/** The payload is checked against its schema def at the writer, so a drifted field fails here and not in a later fold. */
function checked(def: string, type: string, payload: Record<string, unknown>): NewEvent {
  const check = validateDef("scenario.schema.json", def, payload);
  if (!check.ok) throw new Error(`invalid ${type} event: ${check.errors}`);
  return { actor: "omf", type, payload };
}

/**
 * S2 (spec §5.3). In order:
 * 1. preflight: the state-tree guard and the poka-yoke, before anything is read or written;
 * 2. take `seal.lock` without waiting (held: `refused seal_in_progress`); it is released in `finally`;
 * 3. verified ledger read, fold, GATE-1 under `now`: not pass is `blocked_gate1`, nothing appended, author uncalled;
 * 4. any `work.started` for the item: the author preceded it and a seal exists is `reused` (nothing written, no author
 *    call), otherwise `refused implementation_started`;
 * 5. `sealInputsFor` and `buildSealPrompt` (`blocked_input` on a `SealInputError`);
 * 6. append `seal.requested`, with `round` = completed seals + 1;
 * 7. run the author. A failure appends `seal.failed` and consumes no round;
 * 8. intake. The author's identity is the session's own `vendor`, `model` and `isolation` plus the injected clock; whatever
 *    the YAML says about itself is ignored and counted. Zero stored is `seal.failed no_valid_scenarios`;
 * 9. write the set into `<work_id>/<seal_id>/`, files first. The name is unique per seal, so concurrent or crashed seals
 *    never collide and nothing is swept or deleted (orphans wait for a later `vault gc`);
 * 10. inside one `appendWith`, recount completed seals and append `seal.completed`.
 * The lock is held from step 2 to step 10.
 */
export async function runSealStage(deps: SealDeps): Promise<SealStageResult> {
  const { location, item, env } = deps;
  const preflight =
    deps.preflight ??
    ((): void => {
      assertStateTreeClean(location, env);
      assertNoSealedInRepo(location, env);
    });
  preflight();

  const lock = sealLockFile(item.dir);
  try {
    acquireLock(lock);
  } catch (err) {
    if (err instanceof LockHeldError) return { status: "refused", reason: "seal_in_progress" };
    throw err;
  }
  try {
    return await sealLocked(deps);
  } finally {
    releaseLock(lock);
  }
}

async function sealLocked(deps: SealDeps): Promise<SealStageResult> {
  const { location, item, session, ledger } = deps;
  const scope: DecisionScope = { goal_id: item.front.goal_id, work_id: item.front.work_id };
  const now = deps.now();

  const events = ledger.readVerified();
  const state = foldDecisions(events, scope);
  const leak = loadLeakContext(location.dir, scope.goal_id, events);
  const gate1 = evaluateGate1(state, now, { leak, intentQuestionIds: intentQuestionIds(item.intent.candidate.open_questions.length) });
  if (gate1.status !== "pass") return { status: "blocked_gate1", reasons: gate1.reasons };

  const seals = foldSeals(events, scope);
  const started = events.some(
    (event) => event.type === WORK_STARTED_EVENT && event.payload.goal_id === scope.goal_id && event.payload.work_id === scope.work_id,
  );
  if (started) {
    // Any actor's work.started counts here: a forged one makes the order check fail closed instead of re-sealing.
    return authorPrecedesStart(events, scope).ok && seals.latest !== null
      ? { status: "reused", seal: seals.latest }
      : { status: "refused", reason: "implementation_started" };
  }

  let prompt: string;
  try {
    prompt = buildSealPrompt(sealInputsFor(item, state, leak, deps.feedback));
  } catch (err) {
    if (err instanceof SealInputError) return { status: "blocked_input", code: err.code };
    throw err;
  }

  const digest = decisionsDigest(state);
  const round = seals.completed + 1;
  const { feedback } = deps;
  ledger.append(
    checked("ev_seal_requested", "seal.requested", {
      goal_id: scope.goal_id,
      work_id: scope.work_id,
      round,
      author: { vendor: session.vendor, model: session.model, isolation: session.isolation },
      input_sha256: sha256Hex(prompt),
      decisions_digest: digest,
      feedback:
        feedback === undefined
          ? null
          : { unlinked_decision_count: feedback.unlinked_decision_ids.length, weak: feedback.weak, contradictions: feedback.contradictions, invalid: feedback.invalid },
    }),
  );

  const outcome = await session.run({ prompt, timeoutMs: deps.timeoutMs ?? DEFAULT_AUTHOR_TIMEOUT_MS });
  const fail = (code: SealFailureCode, durationMs: number): SealStageResult => {
    ledger.append(checked("ev_seal_failed", "seal.failed", { goal_id: scope.goal_id, work_id: scope.work_id, round, code, duration_ms: Math.round(durationMs) }));
    return { status: "failed", code };
  };
  if (!outcome.ok) return fail(outcome.code, outcome.durationMs);

  const author: AuthorStamp = { vendor: session.vendor, model: session.model, at: now.toISOString(), isolation: session.isolation };
  const intake = intakeAuthored(outcome.output, { workId: scope.work_id, author, ids: deps.ids });
  if (intake.stored.length === 0) return fail("no_valid_scenarios", outcome.durationMs);

  const sealId = deps.ids.sealId();
  let setSha256: string;
  try {
    setSha256 = writeScenarioSet(deps.vault, { work_id: scope.work_id, seal_id: sealId }, intake.stored).set_sha256;
  } catch {
    // The reason stays out of the ledger (a path or an OS message); a person reads the vault directory.
    return fail("write_failed", outcome.durationMs);
  }

  const count = (match: (scenario: (typeof intake.stored)[number]) => boolean): number => intake.stored.filter(match).length;
  const counts: SealCounts = {
    authored: intake.authored,
    stored: intake.stored.length,
    behavior: count((scenario) => scenario.kind === "behavior"),
    contradiction_canary: count((scenario) => scenario.kind === "contradiction_canary"),
    train: count((scenario) => scenario.split === "train"),
    test: count((scenario) => scenario.split === "test"),
    rejected: Object.values(intake.rejected).reduce((sum, n) => sum + n, 0),
    ignored_fields: intake.ignored_fields,
  };
  // The round is recounted under the ledger lock, so it follows completed seals only, whatever else was written meanwhile.
  const written = ledger.appendWith((current) =>
    checked("ev_seal_completed", "seal.completed", {
      goal_id: scope.goal_id,
      work_id: scope.work_id,
      round: foldSeals(current, scope).completed + 1,
      seal_id: sealId,
      author,
      decisions_digest: digest,
      set_sha256: setSha256,
      counts,
      rejected_by_code: intake.rejected,
    }),
  );
  return { status: "stored", round: Number(written.payload.round), seal_id: sealId, set_sha256: setSha256, counts, author };
}
