import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize } from "../core/canonical-json.js";
import { writePrivateFileAtomic } from "../core/private-fs.js";
import { validate } from "../core/schema.js";
import { auditCompletedEvent, auditPayloadOf } from "../gate/events.js";
import { RUN_ID_PATTERN } from "../work/w-events.js";
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

/** `<itemDir>/runs/<run_id>/audit.json`: a view of the run's `audit.completed` event. */
export function auditPath(itemDir: string, runId: string): string {
  return join(itemDir, "runs", runId, "audit.json");
}

function writeAuditFile(itemDir: string, runId: string, report: WorkAudit): void {
  writePrivateFileAtomic(auditPath(itemDir, runId), `${JSON.stringify(report, null, 2)}\n`);
}

/**
 * Ledger event first, then the atomic host file (the M2b/M3b1 order). A crash between the two leaves an event and
 * no file, which `loadAudit` reads as absent and `repairAudit` heals. An invalid report throws before the event, so
 * the ledger never holds an audit that the schema refuses.
 */
export function recordAudit(sink: RecordSink, scope: RunScope, itemDir: string, report: WorkAudit): void {
  const check = validate("work-audit.schema.json", report);
  if (!check.ok) throw new Error(`invalid audit report: ${check.errors}`);
  const event = auditCompletedEvent(scope, report);
  sink.append(event);
  writeAuditFile(itemDir, scope.run_id, report);
}

const SCOPE_KEYS: readonly string[] = ["goal_id", "work_id", "run_id"];

function withoutScope(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !SCOPE_KEYS.includes(key)));
}

/**
 * The closed fields the ledger vouches for: the payload of the run's valid `audit.completed` events written by
 * `omf`. Events by another actor and events that fail the schema are not evidence. Two valid events that
 * disagree make the audit untrustworthy (null), so a second, differing event can never replace the first.
 */
function authoritativePayload(events: readonly LedgerEvent[], runId: string): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  for (const event of events) {
    if (event.type !== "audit.completed" || event.actor !== "omf" || event.payload.run_id !== runId) continue;
    if (!validate("gate-event.schema.json", { type: event.type, payload: event.payload }).ok) continue;
    const fields = withoutScope(event.payload);
    if (found !== null && canonicalize(found) !== canonicalize(fields)) return null;
    found = fields;
  }
  return found;
}

function readAuditFile(itemDir: string, runId: string): WorkAudit | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(auditPath(itemDir, runId), "utf8"));
    return validate("work-audit.schema.json", parsed).ok ? (parsed as WorkAudit) : null;
  } catch {
    return null; // missing or unparseable: the view is gone, and the event stays the authority
  }
}

/**
 * The run's audit, or null. `audit.json` is accepted only when every closed field equals the `audit.completed`
 * event (canary status and total, judge_config_touched, judge_files_checked, tests_edited_count, prove status and
 * reason, risk class and the rest of `auditPayloadOf`). GATE-3 reads the audit through this function or straight
 * from the event payload, never from the raw file. The path lists are not in the event, but their lengths are
 * pinned to the authenticated counts (`listsMatchCounts`), so a file cannot empty `high_risk_paths_touched` or
 * `tests_edited` while the count says otherwise; the names inside a list are display data and rendering escapes them.
 */
export function loadAudit(itemDir: string, runId: string, events: readonly LedgerEvent[]): WorkAudit | null {
  if (!RUN_ID_PATTERN.test(runId)) return null;
  const authority = authoritativePayload(events, runId);
  if (authority === null) return null;
  const report = readAuditFile(itemDir, runId);
  if (report === null) return null;
  if (!listsMatchCounts(report)) return null;
  return canonicalize(auditPayloadOf(report)) === canonicalize(authority) ? report : null;
}

/** The capped lists carry as many entries as the authenticated counts say (up to the cap). */
function listsMatchCounts(report: WorkAudit): boolean {
  return (
    report.high_risk_paths_touched.length === Math.min(report.high_risk_paths_count, LIST_CAP) &&
    report.tests_edited.length === Math.min(report.tests_edited_count, LIST_CAP)
  );
}

/**
 * Heals a crash between the event and the file. `rerun` repeats `runAudit` and returns null when its inputs (the
 * surfaces, the quarantine shas) no longer exist. The new report is written only when it equals the event on every
 * closed field. This function never appends: a second, differing `audit.completed` event for one run is not
 * possible, and a rerun that disagrees leaves the audit reading as absent (`not_run` downstream).
 */
export async function repairAudit(
  itemDir: string,
  runId: string,
  events: readonly LedgerEvent[],
  rerun: () => Promise<WorkAudit | null>,
): Promise<WorkAudit | null> {
  const existing = loadAudit(itemDir, runId, events);
  if (existing !== null) return existing;
  const authority = authoritativePayload(events, runId);
  if (authority === null) return null; // no event: nothing to repair, the caller records a fresh audit
  let report: WorkAudit | null;
  try {
    report = await rerun();
  } catch {
    return null; // the inputs are gone
  }
  if (report === null || !validate("work-audit.schema.json", report).ok || !listsMatchCounts(report)) return null;
  if (canonicalize(auditPayloadOf(report)) !== canonicalize(authority)) return null;
  writeAuditFile(itemDir, runId, report);
  return report;
}

/** The `AuditInputs` of the M3b2 classifier (structurally; `"not run"` is its `NOT_RUN`). */
export interface AuditClassifierInputs {
  canary_hits: number | "not run";
  tests_edited: boolean | "not run";
  prove_test: "pass" | "fail" | "not run";
  judge_config_touched: boolean | "not run";
}

/**
 * Feeds the classifier from `auditSignals`, so the two cannot disagree. A canary hit is reported even when the scan
 * did not finish (it is both flawed and unverified); only a scan that found nothing and did not finish is `"not run"`.
 * A part nobody produced is `"not run"`:
 * a missing audit, an unscanned canary surface, a prove-test that was not run or misconfigured, and a
 * judge config that named no file all stop a run short of `success`.
 */
export function auditInputsOf(report: WorkAudit | null): AuditClassifierInputs {
  if (report === null) {
    return { canary_hits: "not run", tests_edited: "not run", prove_test: "not run", judge_config_touched: "not run" };
  }
  const signals = auditSignals(report);
  const proveUnrun = signals.unverified.includes("prove_test_not_run") || signals.unverified.includes("prove_test_misconfigured");
  return {
    canary_hits: report.canary.total > 0 ? report.canary.total : signals.unverified.includes("canary_not_scanned") ? "not run" : 0,
    tests_edited: signals.flawed.includes("test_edited"),
    prove_test: signals.flawed.includes("prove_test_failed") ? "fail" : proveUnrun ? "not run" : "pass",
    judge_config_touched: report.judge_files_checked === 0 ? "not run" : signals.judge_config_touched,
  };
}
