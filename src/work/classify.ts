import type { Gate4Reason, Gate4Severity, Gate4Warning } from "./gate4.js";
import type { GateAggregate, GateStop } from "./gates.js";
import {
  type GateId,
  NOT_RUN,
  type NotRun,
  ROUND_SCOPED_INPUTS,
  STATION_IDS,
  type StationId,
  type StationStatus,
  type UnverifiedArea,
} from "./line-types.js";
import type { OutcomeInput, WOutcome } from "./outcome.js";
import type { ReasonCode, Recommendation } from "./w-events.js";

/**
 * The outcome classifier and the inputs it reads (spec §4.4 step 5, §5.0). Pure: no ledger, no
 * file, no clock. The sequencer fills `EvidenceInputs` through `StationContext.inputs`; this module decides what they mean.
 */

export type Level = "L1" | "L2" | "L3";

/** What the gate run decided, as a closed value: the classifier never parses the gate line text. */
export type GateVerdictInput = "GREEN" | "RED" | "MISCONFIGURED" | NotRun;

/** What GATE-3's audit found. Any field that is `"not run"` makes the evidence incomplete. */
export interface AuditInputs {
  canary_hits: number | NotRun;
  tests_edited: boolean | NotRun;
  prove_test: "pass" | "fail" | NotRun;
  judge_config_touched: boolean | NotRun;
}

/** Scenario counts from S4. A total of 0 is "not run": an empty suite proves nothing. */
export interface SealedInputs {
  train: { pass: number; total: number; flaky: number } | NotRun;
  test: { pass: number; total: number } | NotRun;
}

/**
 * The bag stations fill. Every default is `"not run"` or `"unmeasured"`, so a field nobody produced never reads as passed
 * (E7a). `plan_summary` and `implementer_notes` are untrusted text; they never decide an outcome.
 */
export interface EvidenceInputs {
  audit: AuditInputs;
  sealed: SealedInputs;
  /** Run-wide: measured once per run by the audit and containers, not per round. */
  isolation_level: Level | "unmeasured";
  high_risk_paths_touched: string[] | NotRun;
  /** "not_evaluated" means the check ran but could not decide. */
  noise_check: "ok" | "within_variance" | "not_evaluated" | NotRun;
  /** The OMF_GATES line, produced by the audit. Required: not run is `evidence_incomplete`. */
  gate_line: string | NotRun;
  /** The structured verdict of the same gate run. Required: not run is `evidence_incomplete`. */
  gate_verdict: GateVerdictInput;
  plan_summary: string | NotRun;
  implementer_notes: string | NotRun;
}

export function emptyEvidenceInputs(): EvidenceInputs {
  return {
    audit: { canary_hits: NOT_RUN, tests_edited: NOT_RUN, prove_test: NOT_RUN, judge_config_touched: NOT_RUN },
    sealed: { train: NOT_RUN, test: NOT_RUN },
    isolation_level: "unmeasured",
    high_risk_paths_touched: NOT_RUN,
    noise_check: NOT_RUN,
    gate_line: NOT_RUN,
    gate_verdict: NOT_RUN,
    plan_summary: NOT_RUN,
    implementer_notes: NOT_RUN,
  };
}

/**
 * Puts every round-scoped field (`ROUND_SCOPED_INPUTS`) back to its default, in place: stations hold this same object.
 * Called in the step that opens a round, so a round-1 clean audit or sealed pass can never satisfy round 2.
 * `isolation_level` is run-wide and stays.
 */
export function resetRoundScopedInputs(inputs: EvidenceInputs): void {
  const fresh = emptyEvidenceInputs() as unknown as Record<string, unknown>;
  const target = inputs as unknown as Record<string, unknown>;
  for (const key of ROUND_SCOPED_INPUTS) target[key] = fresh[key];
}

/** Why the line stopped before it reached the end. `none` means every node was visited. */
export type LineStop =
  | { kind: "none" }
  | {
      kind: "gate";
      gate: Exclude<GateId, "GATE-4">;
      verdict: "fail" | "not_run";
      reasons: readonly string[];
      stop?: GateStop;
    }
  // round 0 means before S3 of the first round (the S1/S2 loop or the line-entry guard).
  | { kind: "gate4"; severity: Exclude<Gate4Severity, "none">; reasons: readonly Gate4Reason[]; round: number }
  | { kind: "station"; station: StationId; result: "blocked" | "manual" | "error"; reason_code: ReasonCode };

/** Which row fired. Evidence records it as the first of `recommendation_reasons`. */
export type ClassifierRule =
  | "station_error"
  | "station_manual"
  | "station_blocked"
  | "plan_missing"
  | "gate_not_run"
  | "gate1_open"
  | "gate2_stop"
  | "gate3_flawed"
  | "gate3_blocked"
  | "gate4_integrity"
  | "gate4_hard"
  | "gate4_hard_round0"
  | "gate4_reentry"
  | "gate4_soft"
  | "station_skipped"
  | "evidence_incomplete"
  | "audit_flag"
  | "gates_failed"
  | "gates_misconfigured"
  | "sealed_failed"
  | "flaky_scenario"
  | "within_variance"
  | "success";

export interface ClassifierInput {
  stop: LineStop;
  stations: Record<StationId, StationStatus>;
  gates: GateAggregate;
  inputs: EvidenceInputs;
  /** Ids of quantitative decisions; their `measured` is always "not run" until the sequencer measures them. */
  decisions_unmeasured: readonly string[];
  gate4_warnings: readonly Gate4Warning[];
  /** From `injectedGateIds`: gates that did not come from `defaultGates()`. */
  injected_gates: readonly GateId[];
  declared_level: Level;
}

export interface Classification {
  outcome: WOutcome;
  exhausted: boolean;
  /** null only for success; every other outcome carries a code that `dispositionOf` accepts. */
  reason_code: ReasonCode | null;
  recommendation: Recommendation;
  unverified_areas: UnverifiedArea[];
  rule: ClassifierRule;
}

const LEVEL_RANK: Record<Level, number> = { L1: 1, L2: 2, L3: 3 };

/** What automated verification did not cover. Ids and closed codes only, never text. Computed for every row. */
function unverifiedAreas(input: ClassifierInput): UnverifiedArea[] {
  const { inputs } = input;
  const areas: UnverifiedArea[] = [];
  for (const id of input.decisions_unmeasured) areas.push({ code: "decision_unmeasured", decision_id: id });
  if (input.gate4_warnings.includes("spend_unverifiable"))
    areas.push({ code: "model_spend_unverifiable", decision_id: null });
  if (inputs.noise_check === NOT_RUN) areas.push({ code: "noise_check_not_run", decision_id: null });
  else if (inputs.noise_check === "not_evaluated") areas.push({ code: "noise_check_not_evaluated", decision_id: null });
  if (inputs.high_risk_paths_touched === NOT_RUN) areas.push({ code: "high_risk_paths_not_run", decision_id: null });
  else if (inputs.high_risk_paths_touched.length > 0)
    areas.push({ code: "high_risk_paths_touched", decision_id: null });
  if (input.injected_gates.length > 0) areas.push({ code: "injected_gate", decision_id: null });
  return areas;
}

/** A sealed count counts only when it ran at least one scenario. */
function ran(count: { total: number } | NotRun): boolean {
  return count !== NOT_RUN && count.total > 0;
}

/**
 * A signal that already makes the result flawed: a failing gate line, an audit flag or a flaky train scenario. The
 * sealed test split is used once (spec §5.7) and a flawed line never spends it, so row 6c does not ask for its count then.
 */
function knownFlawed(inputs: EvidenceInputs): boolean {
  return inputs.gate_verdict === "RED" || auditFlagged(inputs.audit) || anyFlaky(inputs.sealed);
}

/** Row 6c: an input a success depends on that nobody produced (or measured too weakly). */
function requiredInputMissing(input: ClassifierInput): boolean {
  const { audit, sealed, gate_line, gate_verdict, isolation_level } = input.inputs;
  if (
    audit.canary_hits === NOT_RUN ||
    audit.tests_edited === NOT_RUN ||
    audit.prove_test === NOT_RUN ||
    audit.judge_config_touched === NOT_RUN
  ) {
    return true;
  }
  if (!ran(sealed.train)) return true;
  if (!ran(sealed.test) && !knownFlawed(input.inputs)) return true;
  if (gate_line === NOT_RUN || gate_verdict === NOT_RUN) return true;
  return isolation_level === "unmeasured" || LEVEL_RANK[isolation_level] < LEVEL_RANK[input.declared_level];
}

/** A canary hit, an edited test, a failed prove_test or a touched judge config. A `"not run"` field is not a flag (6c handles it). */
function auditFlagged(audit: AuditInputs): boolean {
  return (
    (typeof audit.canary_hits === "number" && audit.canary_hits > 0) ||
    audit.tests_edited === true ||
    audit.prove_test === "fail" ||
    audit.judge_config_touched === true
  );
}

/** A scenario counted as failed. Only called once 6c has made sure the train count ran; the test count may be missing when a known-flawed signal made the split unnecessary. */
function sealedFailed(sealed: SealedInputs): boolean {
  const failed = (count: { pass: number; total: number } | NotRun): boolean =>
    count !== NOT_RUN && count.pass < count.total;
  return failed(sealed.train) || failed(sealed.test);
}

/** Any flaky scenario. Checked before sealedFailed: the test run counts a flaky scenario as not passed, so pass < total whenever flaky > 0, and the person must see the flakiness. */
function anyFlaky(sealed: SealedInputs): boolean {
  return sealed.train !== NOT_RUN && sealed.train.flaky > 0;
}

/**
 * Maps what the line produced to the closed outcome . Pure and total: the first matching row wins,
 * in this order: 1 station stop, 2 gate not run, 3 GATE-1, 4 GATE-2 stop, 5 GATE-3, 6 GATE-4, 7 completeness, 8 quality, 9 success.
 * Every row before the last can only lower the result; a `flawed` result needs an implementation behind it (round >= 1).
 */
export function classifyOutcome(input: ClassifierInput): Classification {
  const areas = unverifiedAreas(input);
  const make = (
    outcome: WOutcome,
    exhausted: boolean,
    reason_code: ReasonCode | null,
    rule: ClassifierRule,
  ): Classification => ({
    outcome,
    exhausted,
    reason_code,
    recommendation:
      outcome === "success"
        ? areas.length === 0
          ? "merge_recommended"
          : "human_needed"
        : outcome === "flawed"
          ? "not_recommended"
          : "human_needed",
    unverified_areas: areas,
    rule,
  });
  const { stop, stations, gates, inputs } = input;

  if (stop.kind === "station") {
    if (stop.result === "error") return make("blocked", false, "station_error", "station_error");
    if (stop.result === "manual") return make("manual", false, stop.reason_code, "station_manual");
    // A flawed result needs an implementation behind it, and S3 only runs in a round (>= 1) after the implementer started.
    // The branch is already published, so a person can review it (J4); every other blocked stop stays blocked.
    if (stop.station === "S3" && stop.reason_code === "plan_missing") {
      return make("flawed", false, "plan_missing", "plan_missing");
    }
    return make("blocked", false, stop.reason_code, "station_blocked");
  }
  if (stop.kind === "gate") {
    if (stop.verdict === "not_run") return make("blocked", false, "gate_not_run", "gate_not_run");
    if (stop.gate === "GATE-1") return make("blocked", false, "j2_open", "gate1_open");
    if (stop.gate === "GATE-2" && stop.stop !== undefined) {
      const code = stop.stop === "J2" ? "j2_open" : stop.stop === "J3" ? "scenarios_need_review" : "gate_blocked";
      return make("blocked", false, code, "gate2_stop");
    }
    if (stop.gate === "GATE-3" && stations.S3 === "ok" && auditFlagged(inputs.audit)) {
      return make("flawed", false, "audit_flag", "gate3_flawed");
    }
    return make("blocked", false, "gate_blocked", "gate3_blocked");
  }
  if (stop.kind === "gate4") {
    if (stop.severity === "integrity") return make("blocked", false, "gate_blocked", "gate4_integrity");
    if (stop.reasons.includes("reentry_loop")) return make("blocked", false, "reentry_loop", "gate4_reentry");
    if (stop.severity === "hard") {
      if (stop.round === 0) return make("blocked", false, "gate2_exhausted", "gate4_hard_round0");
      return make("flawed", true, stop.reasons.includes("stalled") ? "stalled" : "visit_cap", "gate4_hard");
    }
    return make("blocked", false, "budget_exhausted", "gate4_soft");
  }

  if (STATION_IDS.some((id) => stations[id] !== "ok"))
    return make("blocked", false, "station_skipped", "station_skipped");
  if (gates.verdict !== "pass") return make("blocked", false, "gate_not_run", "gate_not_run");
  // A misconfigured gate is a fault of the setup, not evidence about the candidate: a person fixes it (blocked, not flawed).
  if (inputs.gate_verdict === "MISCONFIGURED") return make("blocked", false, "gate_blocked", "gates_misconfigured");
  if (requiredInputMissing(input)) return make("blocked", false, "evidence_incomplete", "evidence_incomplete");
  if (auditFlagged(inputs.audit)) return make("flawed", false, "audit_flag", "audit_flag");
  if (inputs.gate_verdict === "RED") return make("flawed", false, "gates_failed", "gates_failed");
  if (anyFlaky(inputs.sealed)) return make("flawed", false, "flaky_scenario", "flaky_scenario");
  if (sealedFailed(inputs.sealed)) return make("flawed", false, "sealed_failed", "sealed_failed");
  if (inputs.noise_check === "within_variance") return make("flawed", false, "within_variance", "within_variance");
  return make("success", false, null, "success");
}

/**
 * The `OutcomeInput` that `dispositionOf` takes. A success is `human_needed` unless it is `merge_recommended`
 * (an unmeasured quantitative decision, unknown spend or an injected gate never gets a plain merge recommendation).
 */
export function toOutcomeInput(c: Classification): OutcomeInput {
  if (c.outcome === "success") {
    return {
      outcome: "success",
      exhausted: false,
      reason_code: null,
      human_needed: c.recommendation !== "merge_recommended",
    };
  }
  return { outcome: c.outcome, exhausted: c.exhausted, reason_code: c.reason_code };
}
