import type { NewEvent } from "../core/ledger.js";
import { validateDef } from "../core/schema.js";
import type { Gate1Result } from "../decision/gate1.js";
import { scenarioLinkCoverage } from "../decision/lint.js";
import type { DecisionScope, DecisionState } from "../decision/types.js";
import type { ScenarioSetRead } from "../vault/vault.js";
import type { AuthorOrder, EffectiveScenario, SealRecord } from "./events.js";
import { contradictions, vaultDecisionLinks } from "./lint.js";
import type { ScenarioProblem } from "./lint.js";
import { EXPOSURE_LIMIT, SCENARIO_SPLITS, isCanaryKind, scenarioRef } from "./types.js";
import type { RefusalCode, ScenarioSplit, SealFeedback } from "./types.js";

/**
 * GATE-2, the pure part (spec §5.3; M3c-D7). A sealed scenario set is a judge only if it is not empty, has both splits, fails
 * the null implementations, carries at least one contradiction canary (owner decision O-2), does not contradict itself, and links every resolved non-quantitative decision. Everything here is
 * a function of its arguments: reading the vault, the ledger and the probes is `runGate2`'s job, so this file can be tested with
 * plain values and a thin adapter can append `gate2EventFor`'s output without a second opinion.
 */

export const GATE2_REASON_CODES = [
  "gate1_not_passing",
  "ledger_anomaly",
  "seal_missing",
  "seal_after_start",
  "set_missing",
  "set_unreadable",
  "set_tampered",
  "decisions_drifted",
  "no_active_scenarios",
  "split_missing",
  "canary_missing",
  "scenario_invalid",
  "contradiction",
  "exposure_exhausted",
  "probe_error",
  "null_impl_passes",
  "judge_broken_or_gamed",
  "unlinked_decisions",
] as const;
export type Gate2ReasonCode = (typeof GATE2_REASON_CODES)[number];

/** Counts, split names, decision ids and refusal codes only: never a scenario id, a canary or any scenario text (M3c-D10). */
export interface Gate2Reason {
  code: Gate2ReasonCode;
  count?: number;
  split?: ScenarioSplit;
  decision_ids?: string[];
  refusal_codes?: RefusalCode[];
}

export type Gate2Route = "J2" | "J3" | "J7" | "back_to_S2";

/**
 * Where each reason sends the item (M3c-D21). J2: GATE-1 no longer passes. J3 (a person looks at the judge): the ledger or the
 * sealed set was touched, or the judge is broken or gamed. J7 (damaged install or environment): a probe could not run. back_to_S2:
 * only author-quality faults (`canary_missing` is one: the author did not write a canary), so a reseal never reruns the author for an environment fault, and a deleted vault file is never
 * answered by a silent reseal. A `Record` over the code union, so a new code cannot be added without choosing its route.
 */
export const GATE2_ROUTE_OF: Readonly<Record<Gate2ReasonCode, Gate2Route>> = {
  gate1_not_passing: "J2",
  ledger_anomaly: "J3",
  seal_after_start: "J3",
  set_missing: "J3",
  set_unreadable: "J3",
  set_tampered: "J3",
  judge_broken_or_gamed: "J3",
  probe_error: "J7",
  seal_missing: "back_to_S2",
  decisions_drifted: "back_to_S2",
  no_active_scenarios: "back_to_S2",
  split_missing: "back_to_S2",
  canary_missing: "back_to_S2",
  scenario_invalid: "back_to_S2",
  contradiction: "back_to_S2",
  null_impl_passes: "back_to_S2",
  unlinked_decisions: "back_to_S2",
  exposure_exhausted: "J3",
};

/** Most severe first: when several routes apply, the first one in this list wins. */
const ROUTES_BY_SEVERITY: readonly Gate2Route[] = ["J2", "J3", "J7", "back_to_S2"];

function routeOf(reasons: readonly Gate2Reason[]): Gate2Route {
  for (const route of ROUTES_BY_SEVERITY) {
    if (reasons.some((reason) => GATE2_ROUTE_OF[reason.code] === route)) return route;
  }
  // Unreachable for a non-empty list; an empty one is a caller bug and must not read as a pass.
  return "back_to_S2";
}

export interface ScenarioAggregate {
  total: number;
  active: number;
  retired: number;
  contaminated: number;
  behavior: { train: number; test: number };
  contradiction_canary: { train: number; test: number };
}
/** The J3 sampling hook (spec: a sample for the person) receives this and nothing else; a person who wants a sample opens the vault files. */
export type J3SamplingHook = (aggregate: ScenarioAggregate) => void;

/** Counts only. Behavior and canary counts are of active scenarios; retired and contaminated ones are counted in their own fields. */
export function scenarioAggregate(scenarios: readonly EffectiveScenario[]): ScenarioAggregate {
  const out: ScenarioAggregate = {
    total: scenarios.length,
    active: 0,
    retired: 0,
    contaminated: 0,
    behavior: { train: 0, test: 0 },
    contradiction_canary: { train: 0, test: 0 },
  };
  for (const { scenario, status } of scenarios) {
    out[status] += 1;
    if (status !== "active") continue;
    if (isCanaryKind(scenario)) out.contradiction_canary[scenario.split] += 1;
    else out.behavior[scenario.split] += 1;
  }
  return out;
}

export type Gate2Result =
  | { status: "pass"; not_run: string[]; aggregate: ScenarioAggregate } // not_run: resolved quantitative decision ids (M3-D17); never success
  | { status: "fail"; route: Gate2Route; reasons: Gate2Reason[]; not_run: string[]; aggregate: ScenarioAggregate | null };

/** M3d supplies this (releases per split digest from its feedback.* events). M3c never counts exposure itself (M3c-D9). */
export type ExposureCount = (key: { split: ScenarioSplit; digest: string }) => number;

export interface ProbeRun {
  scenario_ref: string;
  outcome: "pass" | "fail" | "error";
  refusal?: RefusalCode;
}
/** Behavior scenarios appear in `null_error` and `null_empty`; canaries in all three lists. */
export interface Gate2Probes {
  null_error: ProbeRun[];
  null_empty: ProbeRun[];
  echo: ProbeRun[];
}

export interface Gate2Input {
  gate1: Gate1Result;
  state: DecisionState;
  decisionsDigest: string;
  seal: SealRecord | null;
  order: AuthorOrder;
  anomalies: number;
  /** null when there is no seal to read. */
  set: ScenarioSetRead | null;
  /** The set with ledger statuses applied; empty when the set is not ok. */
  effective: readonly EffectiveScenario[];
  problems: readonly ScenarioProblem[];
  /** null when the set was not trustworthy enough to probe. For a usable set with an active scenario, null is itself `probe_error`. */
  probes: Gate2Probes | null;
  /** The ExposureCount results for the two split digests. */
  exposure: { train: number; test: number };
}

type SetFailure = Extract<ScenarioSetRead, { ok: false }>["reason"];
/** A file that is gone or unreadable is not the same as a file that changed: the second is evidence of tampering. Both are J3. */
const SET_FAILURE_CODE: Readonly<Record<SetFailure, Gate2ReasonCode>> = {
  set_missing: "set_missing",
  symlink_refused: "set_unreadable",
  unreadable: "set_unreadable",
  invalid_scenario: "set_tampered",
  name_mismatch: "set_tampered",
  extra_entry: "set_tampered",
  work_mismatch: "set_tampered",
};

const OUTCOME_BADNESS: Readonly<Record<ProbeRun["outcome"], number>> = { fail: 0, pass: 1, error: 2 };

/** One entry per scenario ref; a duplicate keeps the worse outcome, so a second row cannot hide a pass behind a fail. */
function indexByRef(list: readonly ProbeRun[] | undefined): Map<string, ProbeRun> {
  const out = new Map<string, ProbeRun>();
  for (const run of list ?? []) {
    const seen = out.get(run.scenario_ref);
    if (seen === undefined || OUTCOME_BADNESS[run.outcome] > OUTCOME_BADNESS[seen.outcome]) out.set(run.scenario_ref, run);
  }
  return out;
}

interface ProbeFindings {
  errors: number;
  refusals: RefusalCode[];
  nullPasses: number;
  gamed: number;
}

/** Empty means fail: a probe that is missing or errored counts as an error, and an error never counts as "failed the null". */
function probeFindings(active: readonly EffectiveScenario[], probes: Gate2Probes | null): ProbeFindings {
  const nullError = indexByRef(probes?.null_error);
  const nullEmpty = indexByRef(probes?.null_empty);
  const echo = indexByRef(probes?.echo);
  const refusals = new Set<RefusalCode>();
  let errors = 0;
  let nullPasses = 0;
  let gamed = 0;
  for (const { scenario } of active) {
    const ref = scenarioRef(scenario.scenario_id);
    const canary = isCanaryKind(scenario);
    const runs = (canary ? [nullError, nullEmpty, echo] : [nullError, nullEmpty]).map((index) => index.get(ref));
    let passed = false;
    for (const run of runs) {
      if (run === undefined || run.outcome === "error") {
        errors += 1;
        if (run?.refusal !== undefined) refusals.add(run.refusal);
      } else if (run.outcome === "pass") {
        passed = true;
      }
    }
    if (passed) {
      if (canary) gamed += 1;
      else nullPasses += 1;
    }
  }
  return { errors, refusals: [...refusals].sort(), nullPasses, gamed };
}

/**
 * Pure. Collects every reason (no early return), in this order: gate1_not_passing; ledger_anomaly; seal_missing; seal_after_start;
 * set_missing | set_unreadable | set_tampered; decisions_drifted; no_active_scenarios; split_missing (one per missing split);
 * canary_missing (no active contradiction canary in either split); scenario_invalid; contradiction; exposure_exhausted (one per split); probe_error; null_impl_passes; judge_broken_or_gamed;
 * unlinked_decisions. `pass` only when the list is empty. The route is the most severe one in `GATE2_ROUTE_OF`.
 *
 * Content reasons are derived only from a usable set: a seal exists, the set read ok, and its digest equals `seal.completed`'s.
 * Anything else has already produced its own J3 or back-to-S2 reason, and judging files that are not the sealed ones would only
 * add noise. `contradiction` is counted from the scenarios themselves (`contradictions`), not from lint problems of that code,
 * so the same pair is never counted twice. `not_run` is derived whatever else fails, so a caller can always report it.
 */
export function evaluateGate2(input: Gate2Input): Gate2Result {
  const reasons: Gate2Reason[] = [];
  const { seal, set } = input;

  if (input.gate1.status !== "pass") reasons.push({ code: "gate1_not_passing", count: input.gate1.reasons.length });
  if (input.anomalies > 0) reasons.push({ code: "ledger_anomaly", count: input.anomalies });

  let usable = false;
  if (seal === null) {
    reasons.push({ code: "seal_missing" });
  } else {
    if (input.order.ok === false && input.order.reason === "seal_after_start") reasons.push({ code: "seal_after_start" });
    if (set === null) reasons.push({ code: "set_missing" });
    else if (!set.ok) reasons.push({ code: SET_FAILURE_CODE[set.reason] });
    else if (set.set_sha256 !== seal.set_sha256) reasons.push({ code: "set_tampered" });
    else usable = true;
    if (input.decisionsDigest !== seal.decisions_digest) reasons.push({ code: "decisions_drifted" });
  }

  const scenarios = usable ? input.effective : [];
  const aggregate = usable ? scenarioAggregate(scenarios) : null;
  const active = scenarios.filter((entry) => entry.status === "active");

  if (aggregate !== null) {
    if (aggregate.active === 0) reasons.push({ code: "no_active_scenarios" });
    for (const split of SCENARIO_SPLITS) {
      if (aggregate.behavior[split] === 0) reasons.push({ code: "split_missing", split });
    }
    // Owner decision O-2: every set carries at least one active contradiction canary, so GATE-3's contradiction check is never vacuous.
    if (aggregate.contradiction_canary.train + aggregate.contradiction_canary.test === 0) reasons.push({ code: "canary_missing" });
    const invalid = input.problems.filter((problem) => problem.code !== "contradiction").length;
    if (invalid > 0) reasons.push({ code: "scenario_invalid", count: invalid });
    const pairs = contradictions(scenarios).length;
    if (pairs > 0) reasons.push({ code: "contradiction", count: pairs });
  }

  // Needs no set: the count is keyed by the split digest M3d computes. A count that is not a number cannot prove headroom.
  for (const split of SCENARIO_SPLITS) {
    const count = input.exposure[split];
    if (!Number.isFinite(count) || count >= EXPOSURE_LIMIT) {
      reasons.push({ code: "exposure_exhausted", split, count: Number.isFinite(count) ? count : EXPOSURE_LIMIT });
    }
  }

  if (active.length > 0) {
    const found = probeFindings(active, input.probes);
    if (found.errors > 0) reasons.push({ code: "probe_error", count: found.errors, refusal_codes: found.refusals });
    if (found.nullPasses > 0) reasons.push({ code: "null_impl_passes", count: found.nullPasses });
    if (found.gamed > 0) reasons.push({ code: "judge_broken_or_gamed", count: found.gamed });
  }

  // Quantitative decisions are exempt from linking (M3-D17); a canary names no coverage (vaultDecisionLinks ignores canaries).
  const coverage = scenarioLinkCoverage(input.state, vaultDecisionLinks(scenarios).linkedDecisionIds());
  if (usable && coverage.unlinked.length > 0) {
    reasons.push({ code: "unlinked_decisions", count: coverage.unlinked.length, decision_ids: coverage.unlinked });
  }

  if (reasons.length === 0 && aggregate !== null) return { status: "pass", not_run: coverage.not_run, aggregate };
  return { status: "fail", route: routeOf(reasons), reasons, not_run: coverage.not_run, aggregate };
}

/** The ledger caps the unlinked ids at 100 (`ev_gate2_evaluated`); a set with more is still `fail`, and the next lint run lists the rest. */
const MAX_EVENT_DECISION_IDS = 100;

/**
 * The `gate2.evaluated` event for one evaluation (M3c-D10: codes, counts, digests and decision ids only). Pure; the Task 11 adapter
 * appends it. `digests` come from the caller because a missing seal has none: `seal_id` and `set_sha256` are then null and the counts
 * are zero. A reason code listed twice (one `split_missing` per split) is written once. The payload is validated against
 * `ev_gate2_evaluated` before it is returned and the function throws on a mismatch, like every Task 5 builder: a reason code or
 * route that drifts from the schema enum must never reach `Ledger.append`, which checks only the event envelope.
 */
export function gate2EventFor(
  scope: DecisionScope,
  round: number,
  result: Gate2Result,
  digests: { seal_id: string | null; set_sha256: string | null; decisions_digest: string },
): NewEvent {
  const reasons = result.status === "fail" ? result.reasons : [];
  const unlinked = reasons.find((reason) => reason.code === "unlinked_decisions")?.decision_ids ?? [];
  const aggregate = result.aggregate;
  const payload = {
      goal_id: scope.goal_id,
      work_id: scope.work_id,
      round,
      seal_id: digests.seal_id,
      status: result.status,
      route: result.status === "fail" ? result.route : null,
      reason_codes: [...new Set(reasons.map((reason) => reason.code))],
      unlinked_decision_ids: unlinked.slice(0, MAX_EVENT_DECISION_IDS),
      not_run_decision_ids: [...result.not_run],
      counts: {
        active: aggregate?.active ?? 0,
        behavior_train: aggregate?.behavior.train ?? 0,
        behavior_test: aggregate?.behavior.test ?? 0,
        canaries: (aggregate?.contradiction_canary.train ?? 0) + (aggregate?.contradiction_canary.test ?? 0),
        contaminated: aggregate?.contaminated ?? 0,
        retired: aggregate?.retired ?? 0,
      },
      set_sha256: digests.set_sha256,
      decisions_digest: digests.decisions_digest,
  };
  const checked = validateDef("scenario.schema.json", "ev_gate2_evaluated", payload);
  if (!checked.ok) throw new Error(`invalid gate2.evaluated payload: ${checked.errors}`);
  return { actor: "omf", type: "gate2.evaluated", payload };
}

/**
 * What the next seal prompt may contain after a failed GATE-2 (M3c-D12): the unlinked decision ids and plain counts, nothing that
 * names a scenario. null for a pass and for J2, J3 and J7, which a reseal cannot fix and must not rerun the author for.
 * `canary_missing`, like `split_missing`, has no field here: the closed `SealFeedback` shape stays as it is, and the fixed seal
 * instructions (Task 10) already ask for at least one canary per set.
 */
export function sealFeedbackFor(result: Gate2Result): SealFeedback | null {
  if (result.status !== "fail" || result.route !== "back_to_S2") return null;
  const reasonOf = (code: Gate2ReasonCode): Gate2Reason | undefined => result.reasons.find((reason) => reason.code === code);
  return {
    unlinked_decision_ids: [...(reasonOf("unlinked_decisions")?.decision_ids ?? [])],
    weak: reasonOf("null_impl_passes")?.count ?? 0,
    contradictions: reasonOf("contradiction")?.count ?? 0,
    invalid: reasonOf("scenario_invalid")?.count ?? 0,
  };
}
