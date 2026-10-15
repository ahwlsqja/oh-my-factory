import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LedgerEvent } from "../../src/core/ledger.js";
import type { NoiseCheck } from "../../src/feedback/noise.js";
import { evidenceSealedTest, noiseCheckField, type TestResult } from "../../src/feedback/test-run.js";
import type { TrainCounts } from "../../src/feedback/tally.js";
import { classifyOutcome, emptyEvidenceInputs } from "../../src/work/classify.js";
import { EVIDENCE_JSON, EVIDENCE_MD, buildEvidence, writeEvidence } from "../../src/work/evidence.js";
import { GateBoard } from "../../src/work/gates.js";
import { STATION_IDS, type StationId, type StationStatus } from "../../src/work/line-types.js";
import { foldWorkBudget } from "../../src/work/w-budget.js";
import { makeTempDir } from "./tmp.js";

export interface FeedbackEvidenceInput {
  goalId: string;
  workId: string;
  runId: string;
  events: readonly LedgerEvent[];
  train: TrainCounts;
  test: TestResult | null;
  /** The M3d noise check, or null while none was computed. */
  noise?: NoiseCheck | null;
  now: Date;
}

/** evidence.json and evidence.md as written by M3b2 for a run whose only produced fields are the M3d ones. */
export function feedbackEvidenceFiles(input: FeedbackEvidenceInput): { json: string; md: string } {
  const stations = Object.fromEntries(STATION_IDS.map((id) => [id, "not_run"])) as Record<StationId, StationStatus>;
  const inputs = emptyEvidenceInputs();
  inputs.sealed = {
    train: input.train,
    test: evidenceSealedTest(input.test === null ? "not yet run" : input.test),
  };
  inputs.noise_check = noiseCheckField(input.noise ?? null);
  const board = new GateBoard();
  const classification = classifyOutcome({
    stop: { kind: "none" },
    stations,
    gates: board.aggregate(),
    inputs,
    decisions_unmeasured: [],
    gate4_warnings: [],
    injected_gates: [],
    declared_level: "L2",
  });
  const doc = buildEvidence({
    scope: { work_id: input.workId, goal_id: input.goalId, run_id: input.runId },
    classification,
    stations,
    gates: board,
    inputs,
    injected_gates: [],
    decisions: { list: [], masked: false },
    stage_times: {},
    budget: foldWorkBudget(input.events, input.workId),
    now: input.now,
  });
  const dir = makeTempDir("omf-fb-evidence-");
  writeEvidence(dir, doc);
  return { json: readFileSync(join(dir, EVIDENCE_JSON), "utf8"), md: readFileSync(join(dir, EVIDENCE_MD), "utf8") };
}
