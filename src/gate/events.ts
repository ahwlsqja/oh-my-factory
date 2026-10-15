import type { RoundScope, WorkAudit } from "../audit/work-audit.js";
import { canonicalize } from "../core/canonical-json.js";
import type { LedgerEvent, NewEvent } from "../core/ledger.js";
import { validate } from "../core/schema.js";
import type { GateName } from "../decision/types.js";
import type { StageMeasurement } from "../isolation/types.js";
import type { RiskClass, RiskRule } from "../work/types.js";
import type { GateLineVerdict } from "./gate-line.js";
import type { ProveReason, ProveStatus } from "./prove-test.js";
import type { GateRunResult } from "./run-gates.js";
import type { Gate3Result } from "./gate3.js";

/** The three ids every gate, audit and isolation event carries (structural: only the `WorkAudit` type comes from the audit module). */
interface EventScope {
  goal_id: string;
  work_id: string;
  run_id: string;
}

/** The four ids every round-scoped event carries; picking them keeps a wider caller object out of a payload. */
function roundIds(scope: RoundScope): { goal_id: string; work_id: string; run_id: string; round: number } {
  return { goal_id: scope.goal_id, work_id: scope.work_id, run_id: scope.run_id, round: scope.round };
}

/** `gates.evaluated` (actor `omf`), one per gate run of a round: the composed line plus closed verdict fields. */
export function gatesEvaluatedEvent(scope: RoundScope, result: Pick<GateRunResult, "line" | "verdict">): NewEvent {
  const { verdict } = result;
  const payload: Record<string, unknown> = {
    ...roundIds(scope),
    line: result.line,
    status: verdict.status,
    failing: [...verdict.failing],
    misconfigured: [...verdict.misconfigured],
    reasons: [...verdict.reasons],
  };
  const check = validate("gate-event.schema.json", { type: "gates.evaluated", payload });
  if (!check.ok) throw new Error(`invalid gates.evaluated event: ${check.errors}`);
  return { actor: "omf", type: "gates.evaluated", payload };
}

/**
 * The closed fields of `audit.completed`. The event is the authority and `audit.json` a view:
 * `loadAudit` accepts the file only when `auditPayloadOf(file)` equals the event, so every count, flag and class
 * that GATE-3 reads is here. Counts, booleans and closed lists only: no path, canary or scenario text can enter.
 */
export interface AuditPayload {
  diff_files: number;
  diff_empty: boolean;
  tests_edited: number;
  tests_added: number;
  canary_status: "scanned" | "not_run";
  canary_hits: number;
  judge_config_touched: boolean;
  judge_files_checked: number;
  high_risk_paths: number;
  projections_touched: number;
  special_entries: number;
  risk_declared: RiskClass;
  risk_effective: RiskClass;
  risk_rules: RiskRule[];
  risk_raised: boolean;
  prove_status: ProveStatus | "not_run";
  prove_reason: ProveReason | null;
}

export function auditPayloadOf(report: WorkAudit): AuditPayload {
  const prove = report.prove_test;
  return {
    diff_files: report.diff.files,
    diff_empty: report.diff.empty,
    tests_edited: report.tests_edited_count,
    tests_added: report.tests_added,
    canary_status: report.canary.status,
    canary_hits: report.canary.total,
    judge_config_touched: report.judge_config_touched,
    judge_files_checked: report.judge_files_checked,
    high_risk_paths: report.high_risk_paths_count,
    projections_touched: report.projections_touched.length,
    special_entries: report.diff.special_entries,
    risk_declared: report.risk.declared.class,
    risk_effective: report.risk.effective.class,
    risk_rules: [...report.risk.effective.rules],
    risk_raised: report.risk.raised,
    prove_status: prove === "not_run" ? "not_run" : prove.status,
    prove_reason: prove === "not_run" ? null : prove.reason,
  };
}

/** `audit.completed` (actor `omf`); `headSha` is the commit the audit looked at. Checked against the schema first. */
export function auditCompletedEvent(scope: RoundScope, report: WorkAudit, headSha: string): NewEvent {
  const payload: Record<string, unknown> = { ...roundIds(scope), head_sha: headSha, ...auditPayloadOf(report) };
  const check = validate("gate-event.schema.json", { type: "audit.completed", payload });
  if (!check.ok) throw new Error(`invalid audit.completed event: ${check.errors}`);
  return { actor: "omf", type: "audit.completed", payload };
}

/**
 * `isolation.measured` (spec §7): one container or host measurement of one stage. The payload is ids, a
 * stage, a mode, a level, closed violation codes and a facts hash; mount sources, env names and paths stay in the
 * host-only `isolation.json`. The author stage is measured at seal, so it alone carries `author_scope`
 * (the seal event's ledger seq and the scenario set's hash) and every other stage must not.
 */
export function isolationMeasuredEvent(
  scope: EventScope,
  measurement: StageMeasurement,
  authorScope: { seal_seq: number; set_sha256: string } | null,
): NewEvent {
  if (measurement.stage === "author" && authorScope === null) {
    throw new Error("invalid isolation.measured event: the author stage needs author_scope");
  }
  if (measurement.stage !== "author" && authorScope !== null) {
    throw new Error("invalid isolation.measured event: author_scope belongs to the author stage only");
  }
  const payload: Record<string, unknown> = {
    goal_id: scope.goal_id,
    work_id: scope.work_id,
    run_id: scope.run_id,
    stage: measurement.stage,
    mode: measurement.mode,
    level: measurement.level,
    violations: [...measurement.violations],
    facts_sha256: measurement.facts_sha256,
    author_scope: authorScope === null ? null : { seal_seq: authorScope.seal_seq, set_sha256: authorScope.set_sha256 },
  };
  const check = validate("gate-event.schema.json", { type: "isolation.measured", payload });
  if (!check.ok) throw new Error(`invalid isolation.measured event: ${check.errors}`);
  return { actor: "omf", type: "isolation.measured", payload };
}

/** `gate3.evaluated` (actor `omf`); the schema ties `passed` to `failed` and `route`, so a contradicting result fails here. */
export function gate3EvaluatedEvent(scope: RoundScope, result: Gate3Result): NewEvent {
  const payload: Record<string, unknown> = {
    ...roundIds(scope),
    passed: result.passed,
    failed: [...result.failed],
    route: result.route,
  };
  const check = validate("gate-event.schema.json", { type: "gate3.evaluated", payload });
  if (!check.ok) throw new Error(`invalid gate3.evaluated event: ${check.errors}`);
  return { actor: "omf", type: "gate3.evaluated", payload };
}

interface GatesEvaluatedPayload {
  line: string;
  status: GateLineVerdict["status"];
  failing: GateName[];
  misconfigured: GateName[];
  reasons: GateLineVerdict["reasons"];
}

/**
 * The gate verdict of one round from the ledger alone: the schema-valid `gates.evaluated` events of actor `omf` for this
 * run and round. None is null (GATE-3 reads no gate run); two that disagree are null too, so a later event never replaces
 * the first.
 */
export function gatesVerdictFromEvents(
  events: readonly LedgerEvent[],
  scope: RoundScope,
): Pick<GateRunResult, "verdict"> | null {
  let found: Record<string, unknown> | null = null;
  for (const event of events) {
    if (event.type !== "gates.evaluated" || event.actor !== "omf") continue;
    const p = event.payload;
    if (p.goal_id !== scope.goal_id || p.work_id !== scope.work_id) continue;
    if (p.run_id !== scope.run_id || p.round !== scope.round) continue;
    if (!validate("gate-event.schema.json", { type: event.type, payload: p }).ok) continue;
    if (found !== null && canonicalize(found) !== canonicalize(p)) return null;
    found = p;
  }
  if (found === null) return null;
  const payload = found as unknown as GatesEvaluatedPayload;
  const { status, line } = payload;
  const failing = [...payload.failing];
  const misconfigured = [...payload.misconfigured];
  return { verdict: { status, line, failing, misconfigured, reasons: [...payload.reasons] } };
}
