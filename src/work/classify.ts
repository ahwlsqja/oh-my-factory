import { NOT_RUN, type NotRun, ROUND_SCOPED_INPUTS } from "./line-types.js";

/**
 * The outcome classifier and the inputs it reads (M3b2-D5, D9, D15, D19; spec §4.4 step 5, §5.0). Pure: no ledger, no
 * file, no clock. The sequencer fills `EvidenceInputs` through `StationContext.inputs`; this module decides what they mean.
 */

export type Level = "L1" | "L2" | "L3";

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
  /** Run-wide: measured once by M3e to M3h, not per round. */
  isolation_level: Level | "unmeasured";
  high_risk_paths_touched: string[] | NotRun;
  /** M3-D10 (a): "not_evaluated" means the check ran but could not decide. */
  noise_check: "ok" | "within_variance" | "not_evaluated" | NotRun;
  /** The OMF_GATES line, produced by M3e. Required: not run is `evidence_incomplete`. */
  gate_line: string | NotRun;
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
    plan_summary: NOT_RUN,
    implementer_notes: NOT_RUN,
  };
}

/**
 * Puts every round-scoped field (`ROUND_SCOPED_INPUTS`) back to its default, in place: stations hold this same object.
 * Called in the step that opens a round, so a round-1 clean audit or sealed pass can never satisfy round 2 (M3b2-D5).
 * `isolation_level` is run-wide and stays.
 */
export function resetRoundScopedInputs(inputs: EvidenceInputs): void {
  const fresh = emptyEvidenceInputs() as unknown as Record<string, unknown>;
  const target = inputs as unknown as Record<string, unknown>;
  for (const key of ROUND_SCOPED_INPUTS) target[key] = fresh[key];
}
