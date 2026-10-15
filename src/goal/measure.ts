import { join, relative } from "node:path";
import { type Isolation, type RunnerKind, isolationOf, runMeasurement } from "../adapters/measure-cmd.js";
import type { BudgetState } from "../core/budget.js";
import { canonicalize } from "../core/canonical-json.js";
import { Ledger, type LedgerEvent } from "../core/ledger.js";
import type { ProjectLocation } from "../core/paths.js";
import { writePrivateFile } from "../core/private-fs.js";
import { auditGoal } from "./audit.js";
import {
  type BandAction,
  type BandResult,
  type BandsConfig,
  BandsError,
  type Tier,
  baselineWindowMs,
  detectBand,
  readBands,
} from "./bands.js";
import { type TargetResult, evaluateTarget } from "./evaluate.js";
import { type GoalSemantic, type GoalTarget, goalDir } from "./goal-file.js";
import { workingTreeFingerprint } from "./git.js";

export type MetricRole = "target" | "leading" | "lagging" | "guardrail";
export type GuardrailStatus = "pass" | "breach" | "unevaluated";

export interface MetricMeasurement {
  metric_id: string;
  roles: MetricRole[];
  unit: string;
  value: number | null;
  failure: string | null;
  band: BandResult | null;
  band_action: BandAction | null;
}

/** Written to host state only (spec §4.6): the gap report never goes into a work item or a tracker. */
export interface GapReport {
  schema_version: 1;
  goal_id: string;
  regime: number;
  measured_at: string;
  runner: RunnerKind;
  isolation: Isolation;
  /** The locked target, not the one currently in goal.md. */
  target: GoalTarget & { measured: number | null; result: TargetResult | null };
  metrics: MetricMeasurement[];
  guardrails: { metric_id: string; status: GuardrailStatus }[];
  regime_changes: string[];
  needs_reapproval: boolean;
  budget: BudgetState | null;
  wall_time_exceeded: boolean;
}

export class GoalStopError extends Error {
  constructor(readonly reasons: string[]) {
    super(reasons.join("; "));
    this.name = "GoalStopError";
  }
}

export interface MeasureOptions {
  runner: RunnerKind;
  now?: () => Date;
  env?: NodeJS.ProcessEnv | undefined;
}

function rolesOf(semantic: GoalSemantic, metricId: string): MetricRole[] {
  const roles: MetricRole[] = [];
  if (semantic.target.metric_id === metricId) roles.push("target");
  if (semantic.leading.includes(metricId)) roles.push("leading");
  if (semantic.lagging.includes(metricId)) roles.push("lagging");
  if (semantic.guardrails.includes(metricId)) roles.push("guardrail");
  return roles;
}

/** Earlier values of one metric in the same regime, within the baseline window, oldest first. */
function pastValues(
  events: readonly LedgerEvent[],
  goalId: string,
  metricId: string,
  regime: number,
  sinceMs: number,
): number[] {
  const values: number[] = [];
  for (const event of events) {
    const { payload } = event;
    if (event.type !== "metric.measured" || payload.goal_id !== goalId || payload.metric_id !== metricId) continue;
    if (payload.regime !== regime || Date.parse(event.ts) < sinceMs || typeof payload.value !== "number") continue;
    // Measured while a regime change was pending: not an approved reading, so it is no baseline (carried item 12).
    if (payload.needs_reapproval === true) continue;
    values.push(payload.value);
  }
  return values;
}

function guardrailStatus(entry: MetricMeasurement | undefined): GuardrailStatus {
  if (
    entry === undefined ||
    entry.value === null ||
    entry.band === null ||
    entry.band.status === "insufficient_baseline"
  ) {
    return "unevaluated";
  }
  return entry.band.status === "breach" ? "breach" : "pass";
}

/** What `goal.measured` records about the guardrails; the success check (spec §4.5) reads only this. */
export type GuardrailsAggregate = "pass" | "breach" | "unevaluated" | "none";

/**
 * Precedence breach > unevaluated > pass > none. `none` is only a goal that declares no guardrails. A guardrail
 * whose metric has no bands file is permanently `unevaluated`, so it can never be read as `pass`: not having
 * been judged is not the same as having passed (D9a).
 */
export function aggregateGuardrails(guardrails: readonly { status: GuardrailStatus }[]): GuardrailsAggregate {
  if (guardrails.length === 0) return "none";
  if (guardrails.some((g) => g.status === "breach")) return "breach";
  if (guardrails.some((g) => g.status === "unevaluated")) return "unevaluated";
  return "pass";
}

const TIER_ORDER: readonly Tier[] = ["3sigma", "2sigma", "1sigma"];

/**
 * The action for a breach. A point beyond 3 sigma is also beyond 2 and 1 sigma, so a tier with no action
 * falls back to the next lower tier that has one.
 */
function actionFor(config: BandsConfig, tier: Tier): BandAction | null {
  for (const candidate of TIER_ORDER.slice(TIER_ORDER.indexOf(tier))) {
    const action = config.tiers[candidate]?.action;
    if (action !== undefined) return action;
  }
  return null;
}

class Unchanged extends Error {}

/** Records a regime change, unless the same reasons are already recorded for this regime. */
function recordRegimeChange(ledger: Ledger, goalId: string, regime: number, reasons: string[]): void {
  try {
    ledger.appendWith((events) => {
      const last = events
        .filter((e) => e.type === "goal.regime_changed" && e.payload.goal_id === goalId && e.payload.regime === regime)
        .at(-1);
      if (last !== undefined && canonicalize(last.payload.reasons) === canonicalize(reasons)) throw new Unchanged();
      return { actor: "omf", type: "goal.regime_changed", payload: { goal_id: goalId, regime, reasons } };
    });
  } catch (err) {
    if (!(err instanceof Unchanged)) throw err;
  }
}

function stop(ledger: Ledger, goalId: string, reasons: string[]): never {
  ledger.append({ actor: "omf", type: "goal.audit_failed", payload: { goal_id: goalId, reasons } });
  throw new GoalStopError(reasons);
}

/**
 * One measurement pass (spec §4.4 steps 1 to 3): audit, run every locked metric, evaluate the gap to
 * the locked target and the bands, and write a host-only gap report. An unapproved goal or a lock that
 * does not verify stops before anything runs (E1). A regime change is recorded and labeled, and
 * measurement continues. Metrics run one after another, each in its own process group (spec §4.2).
 */
export async function measureGoal(
  location: ProjectLocation,
  goalId: string,
  options: MeasureOptions,
): Promise<{ report: GapReport; file: string }> {
  const now = options.now ?? ((): Date => new Date());
  const ledger = new Ledger(location.dir, now);
  const audit = auditGoal(location, goalId, now());
  if (audit.state === "draft")
    stop(ledger, goalId, [`goal ${goalId} is not approved (J1); nothing was measured`, ...audit.problems]);
  if (audit.problems.length > 0) stop(ledger, goalId, audit.problems);
  if (audit.locked === null || audit.approval === null) stop(ledger, goalId, ["goal locks could not be verified"]);

  const { goal: goalLock, metrics: metricLocks } = audit.locked;
  const regime = audit.approval.regime;
  const bands = new Map<string, BandsConfig | null>();
  try {
    for (const lock of metricLocks) bands.set(lock.metric_id, readBands(location.dir, goalId, lock.metric_id));
  } catch (err) {
    if (!(err instanceof BandsError)) throw err;
    stop(ledger, goalId, [err.message]);
  }
  if (audit.regime_changes.length > 0) recordRegimeChange(ledger, goalId, regime, audit.regime_changes);

  // Measurements taken while a regime change is pending carry the mark, so nothing downstream reads them as approved.
  const pending = audit.regime_changes.length > 0;
  const history = ledger.readVerified();
  const inputSha = workingTreeFingerprint(location.repo);
  const measuredAt = now();
  const metrics: MetricMeasurement[] = [];
  for (const lock of metricLocks) {
    const entry: MetricMeasurement = {
      metric_id: lock.metric_id,
      roles: rolesOf(goalLock.semantic, lock.metric_id),
      unit: lock.unit,
      value: null,
      failure: null,
      band: null,
      band_action: null,
    };
    const outcome = await runMeasurement(lock, location.repo, options.runner, options.env);
    if (!outcome.ok) {
      entry.failure = outcome.reason;
      ledger.append({
        actor: "omf",
        type: "metric.measure_failed",
        payload: { goal_id: goalId, metric_id: lock.metric_id, regime, runner: options.runner, reason: outcome.reason },
      });
    } else {
      entry.value = outcome.value;
      ledger.append({
        actor: "omf",
        type: "metric.measured",
        payload: {
          goal_id: goalId,
          metric_id: lock.metric_id,
          regime,
          value: outcome.value,
          unit: lock.unit,
          runner: options.runner,
          isolation: isolationOf(options.runner),
          input_sha256: inputSha,
          lock_sha256: lock.sha256,
          needs_reapproval: pending,
        },
      });
      const config = bands.get(lock.metric_id) ?? null;
      if (config !== null) {
        const since = measuredAt.getTime() - baselineWindowMs(config.baseline);
        const band = detectBand(pastValues(history, goalId, lock.metric_id, regime, since), outcome.value);
        entry.band = band;
        if (band.status === "breach") {
          const action = actionFor(config, band.tier);
          entry.band_action = action;
          ledger.append({
            actor: "omf",
            type: "band.breached",
            payload: {
              goal_id: goalId,
              metric_id: lock.metric_id,
              tier: band.tier,
              rule: band.rule,
              action,
              regime,
              needs_reapproval: pending,
            },
          });
        }
      }
    }
    metrics.push(entry);
  }

  const target = goalLock.semantic.target;
  const measured = metrics.find((m) => m.metric_id === target.metric_id)?.value ?? null;
  const report: GapReport = {
    schema_version: 1,
    goal_id: goalId,
    regime,
    measured_at: measuredAt.toISOString(),
    runner: options.runner,
    isolation: isolationOf(options.runner),
    target: { ...target, measured, result: measured === null ? null : evaluateTarget(target, measured) },
    metrics,
    guardrails: goalLock.semantic.guardrails.map((id) => ({
      metric_id: id,
      status: guardrailStatus(metrics.find((m) => m.metric_id === id)),
    })),
    regime_changes: audit.regime_changes,
    needs_reapproval: pending,
    budget: audit.budget,
    wall_time_exceeded: audit.wall_time_exceeded,
  };
  const stamp = report.measured_at.replace(/[:.]/g, "-");
  const file = join(goalDir(location.dir, goalId), "reports", `${stamp}-gap.json`);
  writePrivateFile(file, `${JSON.stringify(report, null, 2)}\n`);
  ledger.append({
    actor: "omf",
    type: "goal.measured",
    payload: {
      goal_id: goalId,
      regime,
      report: relative(location.dir, file),
      // Not a verdict while a regime change is pending: consumers must not count it as met.
      target_met: pending ? null : (report.target.result?.met ?? null),
      needs_reapproval: pending,
      guardrails: aggregateGuardrails(report.guardrails),
    },
  });
  return { report, file };
}
