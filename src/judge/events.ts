import type { RoundScope } from "../audit/work-audit.js";
import { canonicalize } from "../core/canonical-json.js";
import type { LedgerEvent, NewEvent } from "../core/ledger.js";
import { validate } from "../core/schema.js";
import type { ContradictionVerdict } from "../gate/gate3.js";

/**
 * The ledger's record of the judge (spec §5.5): one `judge.round_completed` per judged phase of a round. Counts, the
 * judged commit and three digests only; per-scenario outcomes stay in a host-only file and the schema is closed, so no
 * scenario ref, id or text can enter. GATE-3 reads it for the contradiction canaries and the image pin.
 */

export const JUDGE_PHASES = ["train", "test"] as const;
export type JudgePhase = (typeof JUDGE_PHASES)[number];

export interface JudgeRoundFacts {
  phase: JudgePhase;
  /** The commit the SUT image was built from. */
  candidate_sha: string;
  /** Repetitions per scenario. */
  k: number;
  /** Behavior scenarios judged in this phase; `pass + fail + flaky + error` equals it. */
  scenarios_total: number;
  pass: number;
  fail: number;
  flaky: number;
  error: number;
  /** Contradiction canaries judged, and how many failed in every repetition (the healthy case). */
  contradiction_scenarios: number;
  contradiction_rejected: number;
  /** Hash of everything the harness image is built from, and `sha256:<64 hex>` of both base images. */
  harness_context_sha256: string;
  sut_base_digest: string;
  harness_base_digest: string;
}
export type JudgeRoundPayload = RoundScope & JudgeRoundFacts;

/** The event as OMF appends it (actor `omf`); checked against the schema first, so a bad sha or count fails here. */
export function judgeRoundEvent(scope: RoundScope, facts: JudgeRoundFacts): NewEvent {
  if (facts.pass + facts.fail + facts.flaky + facts.error !== facts.scenarios_total)
    throw new Error("invalid judge.round_completed event: the outcome counts do not add up to scenarios_total");
  if (facts.contradiction_rejected > facts.contradiction_scenarios)
    throw new Error("invalid judge.round_completed event: more canaries rejected than judged");
  const payload: Record<string, unknown> = {
    goal_id: scope.goal_id,
    work_id: scope.work_id,
    run_id: scope.run_id,
    round: scope.round,
    ...facts,
  };
  const check = validate("gate-event.schema.json", { type: "judge.round_completed", payload });
  if (!check.ok) throw new Error(`invalid judge.round_completed event: ${check.errors}`);
  return { actor: "omf", type: "judge.round_completed", payload };
}

/** Every schema-valid `judge.round_completed` event of actor `omf` that names the goal and item, in ledger order. */
export function foldJudgeRounds(
  events: readonly LedgerEvent[],
  scope: { goal_id: string; work_id: string },
): JudgeRoundPayload[] {
  const found: JudgeRoundPayload[] = [];
  for (const event of events) {
    if (event.actor !== "omf" || event.type !== "judge.round_completed") continue;
    if (event.payload.goal_id !== scope.goal_id || event.payload.work_id !== scope.work_id) continue;
    if (!validate("gate-event.schema.json", { type: event.type, payload: event.payload }).ok) continue;
    found.push(event.payload as unknown as JudgeRoundPayload);
  }
  return found;
}

export type ImageCheck = "match" | "mismatch" | "not_run";

/**
 * The harness half of the judge config. The run's first event pins the harness context hash and both base digests; a
 * later event of the same run that differs is a `mismatch`; no event for this round is `not_run`. The pin is per run,
 * not per item: drift between two runs is not detected, in exchange for an upgrade never stranding an item.
 */
export function imageCheck(events: readonly LedgerEvent[], scope: RoundScope): ImageCheck {
  const run = foldJudgeRounds(events, scope).filter((payload) => payload.run_id === scope.run_id);
  const [pin] = run;
  if (pin === undefined || !run.some((payload) => payload.round === scope.round)) return "not_run";
  const same = (p: JudgeRoundPayload): boolean =>
    p.harness_context_sha256 === pin.harness_context_sha256 &&
    p.sut_base_digest === pin.sut_base_digest &&
    p.harness_base_digest === pin.harness_base_digest;
  return run.every(same) ? "match" : "mismatch";
}

/**
 * What the judge says about the contradiction canaries of a round: the train-phase event, because the judge runs the
 * canaries of both splits there. No event, or two train events that disagree, is null (`not_run` downstream).
 */
export function contradictionVerdictOf(events: readonly LedgerEvent[], scope: RoundScope): ContradictionVerdict | null {
  const train = foldJudgeRounds(events, scope).filter(
    (p) => p.run_id === scope.run_id && p.round === scope.round && p.phase === "train",
  );
  const verdictOf = (p: JudgeRoundPayload): ContradictionVerdict => ({
    judged_sha: p.candidate_sha,
    contradiction_scenarios: p.contradiction_scenarios,
    rejected: p.contradiction_rejected,
  });
  const [first, ...rest] = train;
  if (first === undefined) return null;
  const expected = canonicalize(verdictOf(first));
  return rest.every((p) => canonicalize(verdictOf(p)) === expected) ? verdictOf(first) : null;
}
