import { NOT_RUN, type NotRun } from "./line-types.js";

export type Level = "L1" | "L2" | "L3";

export interface AuditInputs {
  canary_hits: number | NotRun;
  tests_edited: boolean | NotRun;
  prove_test: "pass" | "fail" | NotRun;
  judge_config_touched: boolean | NotRun;
}

export interface SealedInputs {
  train: { pass: number; total: number; flaky: number } | NotRun;
  test: { pass: number; total: number } | NotRun;
}

/**
 * The bag the stations fill. Every default is "not run" or "unmeasured": a field nobody produced never reads as
 * passed (E7a, M3b2-D9). `plan_summary` and `implementer_notes` are untrusted text; the evidence renderer caps them.
 */
export interface EvidenceInputs {
  audit: AuditInputs;
  sealed: SealedInputs; // round-scoped
  isolation_level: Level | "unmeasured"; // run-wide; measured by M3e to M3h
  high_risk_paths_touched: string[] | NotRun; // round-scoped
  /** M3-D10 (a): "not_evaluated" is "the check could not decide". */
  noise_check: "ok" | "within_variance" | "not_evaluated" | NotRun; // round-scoped
  gate_line: string | NotRun; // the OMF_GATES line, produced by M3e; required
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
