import type { LedgerEvent, NewEvent } from "../core/ledger.js";
import type { JudgeConfigDecl } from "../decision/types.js";
import type { ProveTestResult } from "../gate/prove-test.js";
import type { GitTarget } from "../git/hardened.js";
import { rawDiff, treePaths } from "../git/ops.js";
import type { RiskAssessment } from "../work/types.js";
import { assessDiffRisk, classifyDiff } from "./diff.js";
import { type AuditSurface, type CanaryScan, scanCanaries } from "./canary-scan.js";
import { judgeConfigTouched, resolveJudgeFiles } from "./judge-files.js";

export interface AuditInput {
  quarantine: GitTarget;
  /** 40-hex shas. */
  base: string;
  head: string;
  declaredRisk: RiskAssessment;
  watchedGlobs: readonly string[];
  extraGlobs: readonly string[];
  /** From the ledger interface entry, never from the tree. */
  judge: JudgeConfigDecl;
  /** The same array `proveTest` received. */
  explicitTestPaths: readonly string[];
  /** Default `["spec.md", "intent.md"]`; M3g passes the real locations. */
  projectionPaths: readonly string[];
  canaries: readonly string[];
  surfaces: readonly AuditSurface[];
  proveTest: ProveTestResult | null;
}

/** Named `WorkAudit`: `AuditReport` already exists in `src/goal/audit.ts` (the goal audit M3b1 governance reads). */
export interface WorkAudit {
  schema_version: 1;
  diff: { files: number; empty: boolean; special_entries: number };
  /** Capped at 200 listed; `tests_edited_count` is the true count. */
  tests_edited: string[];
  tests_edited_count: number;
  tests_added: number;
  canary: CanaryScan;
  judge_config_touched: boolean;
  judge_files_checked: number;
  projections_touched: string[];
  risk: { declared: RiskAssessment; recomputed: RiskAssessment | null; effective: RiskAssessment; raised: boolean };
  /** `recomputed.paths`: diff-based, `[]` on an empty diff. Capped at 200 listed; `high_risk_paths_count` is the true count. */
  high_risk_paths_touched: string[];
  high_risk_paths_count: number;
  prove_test: ProveTestResult | "not_run";
}

const LIST_CAP = 200;
const cap = (list: readonly string[]): string[] => list.slice(0, LIST_CAP);
const capRisk = (risk: RiskAssessment): RiskAssessment => ({ class: risk.class, rules: [...risk.rules], paths: cap(risk.paths) });

/**
 * The audit of the real diff between two shas of the quarantine repository. A git failure (a path that is not valid UTF-8, a
 * missing repository) rejects: an audit that could not look at the diff is not an audit. An empty diff skips the risk recompute. The judge config comes from the ledger argvs; zero resolved files gives
 * `judge_files_checked: 0`, which downstream reads as `not_run`, never as unchanged.
 */
export async function runAudit(input: AuditInput): Promise<WorkAudit> {
  const entries = await rawDiff(input.quarantine, input.base, input.head);
  const facts = classifyDiff(entries, input.explicitTestPaths, input.projectionPaths);
  const baseTree = await treePaths(input.quarantine, input.base);
  const { gates, test_command } = input.judge;
  const argvs = [gates.fast, gates.full, gates.deep, test_command].filter((argv): argv is string[] => argv !== null && argv.length > 0);
  const judge = resolveJudgeFiles(argvs, baseTree, facts.paths);
  const canary = await scanCanaries(input.canaries, input.surfaces);
  const risk = assessDiffRisk(facts, input.declaredRisk, { watchedGlobs: input.watchedGlobs, extraGlobs: input.extraGlobs });
  return {
    schema_version: 1,
    diff: { files: facts.files, empty: facts.empty, special_entries: facts.special_entries },
    tests_edited: cap(facts.tests_edited),
    tests_edited_count: facts.tests_edited.length,
    tests_added: facts.tests_added,
    canary,
    judge_config_touched: judgeConfigTouched(judge, facts.paths),
    judge_files_checked: judge.tracked.length + judge.config_globs.length,
    projections_touched: cap(facts.projections_touched),
    risk: {
      declared: input.declaredRisk,
      recomputed: risk.recomputed === null ? null : capRisk(risk.recomputed),
      effective: capRisk(risk.effective),
      raised: risk.raised,
    },
    high_risk_paths_touched: cap(risk.recomputed?.paths ?? []),
    high_risk_paths_count: risk.recomputed?.paths.length ?? 0,
    prove_test: input.proveTest ?? "not_run",
  };
}

export type FlawedSignal = "prove_test_failed" | "canary_hit" | "test_edited";
export type UnverifiedSignal = "canary_not_scanned" | "prove_test_not_run" | "prove_test_misconfigured";
export interface AuditSignals {
  /** Spec §5.6. */
  flawed: FlawedSignal[];
  /** Never flawed, never a pass: reported in `unverified_areas`. */
  unverified: UnverifiedSignal[];
  /** GATE-3, not an outcome class. */
  judge_config_touched: boolean;
  /** Effective risk high, projections touched, special entries, or judge config touched: the diff needs a person's review. */
  review_required: boolean;
}

/** One mapping from the audit to what the classifier and the evidence need, so they cannot disagree. */
export function auditSignals(report: WorkAudit): AuditSignals {
  const flawed: FlawedSignal[] = [];
  if (report.prove_test !== "not_run" && report.prove_test.status === "FAILED") flawed.push("prove_test_failed");
  if (report.canary.total > 0) flawed.push("canary_hit");
  if (report.tests_edited_count > 0) flawed.push("test_edited");

  const unverified: UnverifiedSignal[] = [];
  if (report.canary.status === "not_run") unverified.push("canary_not_scanned");
  if (report.prove_test === "not_run") unverified.push("prove_test_not_run");
  else if (report.prove_test.status === "MISCONFIGURED") unverified.push("prove_test_misconfigured");

  return {
    flawed,
    unverified,
    judge_config_touched: report.judge_config_touched,
    review_required:
      report.risk.effective.class === "high" || report.projections_touched.length > 0 || report.diff.special_entries > 0 || report.judge_config_touched,
  };
}

/** Where `recordAudit` appends. `Ledger` satisfies it: audit events are plain ledger appends (only the budget events are claim-checked). */
export interface RecordSink {
  append(event: NewEvent): LedgerEvent;
}

/** The three ids every gate, audit and isolation event carries. */
export interface RunScope {
  goal_id: string;
  work_id: string;
  run_id: string;
}
