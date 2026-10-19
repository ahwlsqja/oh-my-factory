import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RecordSink, RunScope } from "../audit/work-audit.js";
import type { LedgerEvent } from "../core/ledger.js";
import { writePrivateFileAtomic } from "../core/private-fs.js";
import { validate } from "../core/schema.js";
import { isolationMeasuredEvent } from "../gate/events.js";
import { foldSeals } from "../scenario/events.js";
import {
  ISOLATION_STAGES,
  type IsolationLevel,
  type IsolationStage,
  type RunIsolation,
  runIsolation,
  type StageMeasurement,
  type ViolationCode,
} from "./types.js";

/** The author stage is measured at seal. This names the seal event (its ledger seq) and the scenario set it covered. */
export interface AuthorScope {
  seal_seq: number;
  set_sha256: string;
}

/** The payload of an `isolation.measured` event, after the schema check. */
export interface IsolationMeasuredPayload extends RunScope {
  stage: IsolationStage;
  mode: "container" | "host";
  level: IsolationLevel;
  violations: ViolationCode[];
  facts_sha256: string;
  author_scope: AuthorScope | null;
}

interface IsolationView {
  schema_version: 1;
  run_id: string;
  stages: Record<IsolationStage, StageMeasurement[]>;
  level: string;
}

/** `<item>/runs/<run_id>/isolation.json`: host-only, 0600, replaced atomically. A view of the events, never an input to a verdict. */
export function isolationPath(itemDir: string, runId: string): string {
  return join(itemDir, "runs", runId, "isolation.json");
}

function viewOf(runId: string, measurements: readonly StageMeasurement[]): IsolationView {
  const stages = {} as Record<IsolationStage, StageMeasurement[]>;
  for (const stage of ISOLATION_STAGES) stages[stage] = measurements.filter((entry) => entry.stage === stage);
  return { schema_version: 1, run_id: runId, stages, level: runIsolation(runId, measurements).level };
}

/** The measurements the file already lists. A missing, corrupt or foreign file lists none; the ledger still has them. */
function readView(path: string, runId: string): StageMeasurement[] {
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!validate("isolation.schema.json", parsed).ok) return [];
    const view = parsed as IsolationView;
    return view.run_id === runId ? ISOLATION_STAGES.flatMap((stage) => view.stages[stage]) : [];
  } catch {
    return [];
  }
}

/**
 * Ledger event first, then the file (the order the goal budget uses): a crash between the two leaves an event and a file that is one
 * entry behind, and the event is what counts. The measurement is checked against the schema before the event is appended, so a
 * malformed one fails here and never reaches the ledger. The file is written best effort after the event and appends; it never replaces an earlier entry.
 */
export function recordStageMeasurement(
  sink: RecordSink,
  scope: RunScope,
  itemDir: string,
  measurement: StageMeasurement,
  authorScope?: AuthorScope,
): void {
  const event = isolationMeasuredEvent(scope, measurement, authorScope ?? null);
  const path = isolationPath(itemDir, scope.run_id);
  // The measurement alone is checked before the ledger: a malformed one never reaches it.
  const single = validate("isolation.schema.json", viewOf(scope.run_id, [measurement]));
  if (!single.ok) throw new Error(`invalid isolation.json: ${single.errors}`);
  sink.appendWith(() => event);
  // The file is a view of the events and never an input to a verdict, so it cannot fail a measurement: a run that outgrows
  // the schema's list cap (or a full disk) keeps its ledger events and a view that stops at its last valid state.
  try {
    const view = viewOf(scope.run_id, [...readView(path, scope.run_id), measurement]);
    if (validate("isolation.schema.json", view).ok) writePrivateFileAtomic(path, `${JSON.stringify(view, null, 2)}\n`);
  } catch {
    // best effort
  }
}

/**
 * The item's latest valid `seal.completed`, folded by `foldSeals` (the same reading GATE-2 uses): bound to the goal and
 * work item, schema-checked, one record per seal id. A fold anomaly (an invalid omf seal event, a repeated seal id) means the
 * seal cannot be trusted, so there is none. A seal stamped `host_command` also leaves the author stage unmeasured: no
 * container measured it, whatever a container-mode event claims.
 */
function sealOf(events: readonly LedgerEvent[], scope: RunScope): AuthorScope | null {
  const fold = foldSeals(events, { goal_id: scope.goal_id, work_id: scope.work_id });
  const { latest } = fold;
  if (fold.anomalies > 0 || latest === null || latest.author.isolation === "host_command") return null;
  return { seal_seq: latest.seq, set_sha256: latest.set_sha256 };
}

/**
 * The run's isolation, derived from the ledger alone. Every schema-valid `isolation.measured` event of actor `omf` that names
 * the scope's goal and work item counts: of this run for the three run-scoped stages, and for the author stage those whose
 * `author_scope` names the item's latest seal event and its set hash, from whichever run measured it (a resumed run gets a
 * new run id). A stage level is the minimum over all its events, so a restored older L2 never beats a later L1, and a forged
 * L2 with no event reads `unmeasured`. A seal that was superseded, an item with no valid `omf` seal, a seal fold with anomalies or a seal stamped `host_command`
 * leaves the author unmeasured.
 *
 * `_itemDir` is part of the contract and deliberately unused: `isolation.json` is a view of these events and never an input,
 * so a missing, corrupt or edited file cannot change the answer. (Where several author events match one seal, the minimum is
 * taken rather than the latest: the stricter reading of the same rule.)
 */
export function loadRunIsolation(_itemDir: string, scope: RunScope, events: readonly LedgerEvent[]): RunIsolation {
  const seal = sealOf(events, scope);
  const measured: StageMeasurement[] = [];
  for (const event of events) {
    if (event.actor !== "omf" || event.type !== "isolation.measured") continue;
    if (!validate("gate-event.schema.json", { type: event.type, payload: event.payload }).ok) continue;
    const payload = event.payload as unknown as IsolationMeasuredPayload;
    if (payload.goal_id !== scope.goal_id || payload.work_id !== scope.work_id) continue;
    const counts =
      payload.stage === "author"
        ? seal !== null &&
          payload.author_scope?.seal_seq === seal.seal_seq &&
          payload.author_scope.set_sha256 === seal.set_sha256
        : payload.run_id === scope.run_id;
    if (!counts) continue;
    // The events carry the level, the violation codes and the facts hash; the facts themselves stay in isolation.json.
    measured.push({
      stage: payload.stage,
      mode: payload.mode,
      measured_at: event.ts,
      facts: null,
      checks: null,
      level: payload.level,
      violations: payload.violations,
      facts_sha256: payload.facts_sha256,
    });
  }
  return runIsolation(scope.run_id, measured);
}
