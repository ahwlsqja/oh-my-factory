import { SURFACE_KINDS } from "../../src/audit/canary-scan.js";
import type { WorkAudit } from "../../src/audit/work-audit.js";
import type { GateName } from "../../src/decision/types.js";
import { evaluateGateLine, formatGateLine, parseGateLine, type GateLineValues } from "../../src/gate/gate-line.js";
import type { Gate3Parts } from "../../src/gate/gate3.js";
import type { GateRunResult } from "../../src/gate/run-gates.js";
import {
  ISOLATION_STAGES,
  type IsolationLevel,
  type IsolationStage,
  type RunIsolation,
  type StageMeasurement,
  runIsolation,
} from "../../src/isolation/types.js";
import type { RiskAssessment } from "../../src/work/types.js";

export const RUN = "r-20261012T100000Z-ab12";
export const SCOPE = { goal_id: "g-fast", work_id: "w-0123456789ab", run_id: RUN };

/** An audit with a complete, clean canary scan, no judge-config change and a proven prove-test. */
export function cleanAudit(over: Partial<WorkAudit> = {}): WorkAudit {
  const risk: RiskAssessment = { class: "normal", rules: [], paths: [] };
  return {
    schema_version: 1,
    diff: { files: 2, empty: false, special_entries: 0 },
    tests_edited: [],
    tests_edited_count: 0,
    tests_added: 1,
    canary: { status: "scanned", surfaces_scanned: [...SURFACE_KINDS], hits: [], total: 0, symlinks_skipped: 0, truncated: false },
    judge_config_touched: false,
    judge_files_checked: 2,
    projections_touched: [],
    risk: { declared: risk, recomputed: risk, effective: risk, raised: false },
    high_risk_paths_touched: [],
    high_risk_paths_count: 0,
    prove_test: { status: "PROVEN", reason: null, test_exit: 1, non_test_paths: 1, test_paths: 1 },
    ...over,
  };
}

/** What `runGates` returns, built from values: the verdict comes from the real gate-line functions. */
export function gateRunOf(values: GateLineValues, required: readonly GateName[]): GateRunResult {
  const line = formatGateLine(values);
  return { line, values, verdict: evaluateGateLine(parseGateLine(line), required), details: [] };
}

export const GREEN_LINE: GateLineValues = { fast: "pass", full: "pass", deep: "skip" };

/** A container measurement with no facts. A level L1 carries one violation, like a real one. The hash differs per `n`. */
export function measurement(stage: IsolationStage, level: IsolationLevel, n = 0): StageMeasurement {
  return {
    stage,
    mode: "container",
    measured_at: "2026-10-12T10:00:00.000Z",
    facts: null,
    checks: null,
    level,
    violations: level === "L1" ? ["privileged"] : [],
    facts_sha256: (ISOLATION_STAGES.indexOf(stage) * 16 + n + 1).toString(16).padStart(64, "0"),
  };
}

export const ALL_L2: Readonly<Record<IsolationStage, IsolationLevel>> = { author: "L2", implementer: "L2", sut: "L2", harness: "L2" };

/** The run isolation of the stages named in `levels`; a stage that is not named was never measured. */
export function isolationFor(levels: Partial<Record<IsolationStage, IsolationLevel>>): RunIsolation {
  const measurements = ISOLATION_STAGES.flatMap((stage) => {
    const level = levels[stage];
    return level === undefined ? [] : [measurement(stage, level)];
  });
  return runIsolation(RUN, measurements);
}

/** Every part healthy; a test overrides the part it wants to break. */
export function healthyParts(over: Partial<Gate3Parts> = {}): Gate3Parts {
  return {
    audit: cleanAudit(),
    gates: gateRunOf(GREEN_LINE, ["fast", "full"]),
    contradiction: "failing",
    isolation: isolationFor(ALL_L2),
    declared: "L2",
    ...over,
  };
}
