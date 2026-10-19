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
import { rawDiff, treePaths, unifiedDiff } from "../git/ops.js";
import { findTestWeakening } from "../work/test-weakening.js";
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
  /** Default `["spec.md", "intent.md"]`; the implementer container passes the real locations. */
  projectionPaths: readonly string[];
  canaries: readonly string[];
  surfaces: readonly AuditSurface[];
  proveTest: ProveTestResult | null;
}

/** Named `WorkAudit`: `AuditReport` already exists in `src/goal/audit.ts` (the goal audit the governance step reads). */
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
const capRisk = (risk: RiskAssessment): RiskAssessment => ({
  class: risk.class,
  rules: [...risk.rules],
  paths: cap(risk.paths),
});

/** The test-weakening check on the real diff text. A diff that cannot be read in full (`output_limit`, a failure) gives `null`: the risk stays conservative. */
async function testWeakening(input: AuditInput, auditedPaths: readonly string[]): Promise<string[] | null> {
  try {
    const text = (await unifiedDiff(input.quarantine, input.base, input.head)).toString("utf8");
    return findTestWeakening(text, input.explicitTestPaths, auditedPaths);
  } catch {
    return null;
  }
}

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
  const argvs = [gates.fast, gates.full, gates.deep, test_command].filter(
    (argv): argv is string[] => argv !== null && argv.length > 0,
  );
  const judge = resolveJudgeFiles(argvs, baseTree, facts.paths);
  const canary = await scanCanaries(input.canaries, input.surfaces);
  const risk = assessDiffRisk(
    facts,
    input.declaredRisk,
    { watchedGlobs: input.watchedGlobs, extraGlobs: input.extraGlobs, explicitTestPaths: input.explicitTestPaths },
    await testWeakening(input, facts.paths),
  );
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
      report.risk.effective.class === "high" ||
      report.projections_touched.length > 0 ||
      report.diff.special_entries > 0 ||
      report.judge_config_touched,
  };
}

/**
 * Where `recordAudit` appends. `Ledger` satisfies it: `appendWith` hands `build` the verified events under the
 * ledger lock, so the one-record-per-run check cannot race another writer.
 */
export interface RecordSink {
  appendWith(build: (events: LedgerEvent[]) => NewEvent): LedgerEvent;
}

/** The three ids every gate, audit and isolation event carries. */
export interface RunScope {
  goal_id: string;
  work_id: string;
  run_id: string;
}

/** `RunScope` plus the round: a rework run judges several rounds and each has its own audit. */
export interface RoundScope extends RunScope {
  /** An integer of 1 or more. */
  round: number;
}

const isRound = (round: number): boolean => Number.isInteger(round) && round >= 1;

/** `<itemDir>/runs/<run_id>/audit-<round>.json`: a view of that round's `audit.completed` event. */
export function auditPath(itemDir: string, runId: string, round: number): string {
  if (!isRound(round)) throw new RangeError("an audit belongs to a round of 1 or more");
  return join(itemDir, "runs", runId, `audit-${round}.json`);
}

function writeAuditFile(itemDir: string, scope: RoundScope, report: WorkAudit): void {
  writePrivateFileAtomic(auditPath(itemDir, scope.run_id, scope.round), `${JSON.stringify(report, null, 2)}\n`);
}

/**
 * Event first, then the atomic file; a crash between the two leaves an event and no file, which `loadAudit` reads as
 * absent and `repairAudit` heals. An invalid report throws before the event. A round has one audit: a second record for
 * the same run and round is refused, identical or not. `headSha` is the commit audited; GATE-3 compares it with the
 * commit the judge ran.
 */
export function recordAudit(
  sink: RecordSink,
  scope: RoundScope,
  itemDir: string,
  report: WorkAudit,
  headSha: string,
): void {
  const check = validate("work-audit.schema.json", report);
  if (!check.ok) throw new Error(`invalid audit report: ${check.errors}`);
  sink.appendWith((events) => {
    const recorded = events.some(
      (e) => e.type === "audit.completed" && e.payload.run_id === scope.run_id && e.payload.round === scope.round,
    );
    if (recorded) throw new Error(`an audit for run ${scope.run_id} round ${scope.round} is already recorded`);
    return auditCompletedEvent(scope, report, headSha);
  });
  writeAuditFile(itemDir, scope, report);
}

const SCOPE_KEYS: readonly string[] = ["goal_id", "work_id", "run_id", "round"];

function without(payload: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !keys.includes(key)));
}

/**
 * What the ledger vouches for: the payload (minus ids and round, `head_sha` kept) of the valid `audit.completed`
 * events of this run and round written by `omf`. Two valid events that disagree make the audit untrustworthy (null).
 */
function authoritativePayload(events: readonly LedgerEvent[], scope: RoundScope): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  for (const event of events) {
    if (event.type !== "audit.completed" || event.actor !== "omf") continue;
    const p = event.payload;
    if (p.run_id !== scope.run_id || p.goal_id !== scope.goal_id || p.work_id !== scope.work_id) continue;
    if (p.round !== scope.round) continue;
    if (!validate("gate-event.schema.json", { type: event.type, payload: p }).ok) continue;
    const fields = without(p, SCOPE_KEYS);
    if (found !== null && canonicalize(found) !== canonicalize(fields)) return null;
    found = fields;
  }
  return found;
}

/** The commit the round's audit looked at, from the ledger event alone; null without a valid audit event. */
export function auditHeadSha(events: readonly LedgerEvent[], scope: RoundScope): string | null {
  if (!isRound(scope.round)) return null;
  const head = authoritativePayload(events, scope)?.head_sha;
  return typeof head === "string" ? head : null;
}

function readAuditFile(itemDir: string, scope: RoundScope): WorkAudit | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(auditPath(itemDir, scope.run_id, scope.round), "utf8"));
    return validate("work-audit.schema.json", parsed).ok ? (parsed as WorkAudit) : null;
  } catch {
    return null; // missing or unparseable: the view is gone, and the event stays the authority
  }
}

/**
 * The round's audit, or null. The file is accepted only when every closed field equals the round's event
 * (`auditPayloadOf`); the capped path lists are pinned to the authenticated counts (`listsMatchCounts`). GATE-3 reads the
 * audit through this function, never from the raw file.
 */
export function loadAudit(itemDir: string, scope: RoundScope, events: readonly LedgerEvent[]): WorkAudit | null {
  if (!RUN_ID_PATTERN.test(scope.run_id) || !isRound(scope.round)) return null;
  const authority = authoritativePayload(events, scope);
  if (authority === null) return null;
  const report = readAuditFile(itemDir, scope);
  if (report === null || !listsMatchCounts(report)) return null;
  return canonicalize(auditPayloadOf(report)) === canonicalize(without(authority, ["head_sha"])) ? report : null;
}

/** The capped lists carry as many entries as the authenticated counts say (up to the cap). */
function listsMatchCounts(report: WorkAudit): boolean {
  return (
    report.high_risk_paths_touched.length === Math.min(report.high_risk_paths_count, LIST_CAP) &&
    report.tests_edited.length === Math.min(report.tests_edited_count, LIST_CAP)
  );
}

/**
 * Heals a crash between the event and the file. `rerun` repeats `runAudit` (null when its inputs are gone); the new report
 * is written only when it equals the event on every closed field. Never appends.
 */
export async function repairAudit(
  itemDir: string,
  scope: RoundScope,
  events: readonly LedgerEvent[],
  rerun: () => Promise<WorkAudit | null>,
): Promise<WorkAudit | null> {
  if (!RUN_ID_PATTERN.test(scope.run_id) || !isRound(scope.round)) return null;
  const existing = loadAudit(itemDir, scope, events);
  if (existing !== null) return existing;
  const authority = authoritativePayload(events, scope);
  if (authority === null) return null; // no event: nothing to repair
  let report: WorkAudit | null;
  try {
    report = await rerun();
  } catch {
    return null; // the inputs are gone
  }
  if (report === null || !validate("work-audit.schema.json", report).ok || !listsMatchCounts(report)) return null;
  if (canonicalize(auditPayloadOf(report)) !== canonicalize(without(authority, ["head_sha"]))) return null;
  writeAuditFile(itemDir, scope, report);
  return report;
}

/** The `AuditInputs` of the outcome classifier (structurally; `"not run"` is its `NOT_RUN`). */
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
  const proveUnrun =
    signals.unverified.includes("prove_test_not_run") || signals.unverified.includes("prove_test_misconfigured");
  return {
    canary_hits:
      report.canary.total > 0 ? report.canary.total : signals.unverified.includes("canary_not_scanned") ? "not run" : 0,
    tests_edited: signals.flawed.includes("test_edited"),
    prove_test: signals.flawed.includes("prove_test_failed") ? "fail" : proveUnrun ? "not run" : "pass",
    judge_config_touched: report.judge_files_checked === 0 ? "not run" : signals.judge_config_touched,
  };
}
