import { join } from "node:path";
import type { LedgerEvent } from "../../src/core/ledger.js";
import { writePrivateFile } from "../../src/core/private-fs.js";
import { type NoiseCheck, noiseCheck } from "../../src/feedback/noise.js";
import { type ReleaseResult, releaseFeedback } from "../../src/feedback/release.js";
import { type TrainCounts, trainCounts } from "../../src/feedback/tally.js";
import {
  type SealedTestField,
  authorizeTestReseal,
  beginTestRun,
  completeTestRun,
  sealedTestField,
  testRunStateFromEvents,
} from "../../src/feedback/test-run.js";
import type { ScenarioResult } from "../../src/feedback/types.js";
import { CANARY } from "./canary.js";
import { omf } from "./cli.js";
import {
  type EnforcementFixture,
  ledgerEvents,
  setReading,
  setupEnforcementGoal,
  tickCli,
  useCleanModel,
} from "./enforcement-goal.js";
import { type FakeVaultScenario, digestOf, makeSet, mulberry32, toResults, verdictsFor } from "./feedback-canary.js";
import { feedbackEvidenceFiles } from "./feedback-evidence.js";

/** A top-level file in the project dir that holds the planted scenarios; the tree scan skips exactly this file. */
export const HOST_FILE_NAME = "e2wb-host-scenarios.json";
const CANDIDATE_SHA = "0123456789abcdef0123456789abcdef01234567";

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}
export interface FeedbackPipelineRun {
  fx: EnforcementFixture;
  workId: string;
  train: FakeVaultScenario[];
  test: FakeVaultScenario[];
  hostFile: string;
  rounds: { text: string; kinds: string[]; units: 0 | 1 }[];
  trainCounts: TrainCounts;
  noise: NoiseCheck;
  sealedTest: SealedTestField;
  evidence: { json: string; md: string };
  tick1: CliRun;
  tick2: CliRun;
  status: CliRun;
  list: CliRun;
}

const PLAN: readonly { passing: number[]; flaky: number[] }[] = [
  { passing: [0, 1, 6], flaky: [5] },
  { passing: [0, 1, 6], flaky: [5] },
  { passing: [0, 1, 2, 3, 4, 6], flaky: [5] },
  { passing: [0, 6, 7], flaky: [] },
];

function requireOk(label: string, result: CliRun): CliRun {
  if (result.code !== 0) throw new Error(`${label} exited ${result.code}: ${result.stderr}`);
  return result;
}

function released(result: ReleaseResult): Extract<ReleaseResult, { status: "released" }> {
  if (result.status !== "released") throw new Error(`the fixture release was withheld: ${result.reason}`);
  return result;
}

/** `r-<yyyymmdd>T<hhmmss>Z-<4 hex>` with the round number in both parts. */
const runIdOf = (n: number): string => `r-20261014T10000${n}Z-000${n}`;

export function runFeedbackPipeline(): FeedbackPipelineRun {
  const fx = setupEnforcementGoal({ disclosure: 40 });
  useCleanModel(fx);
  const tick1 = requireOk("first tick", tickCli(fx));
  const workId = ledgerEvents(fx, "work.created")[0]?.payload.work_id;
  if (typeof workId !== "string") throw new Error("the first tick created no work item");

  const random = mulberry32(7731);
  const train = makeSet(random, [
    { refs: ["d-interface"], count: 6 },
    { refs: ["d-interface", "d-errors"], count: 6 },
  ]);
  const test = makeSet(random, [{ refs: ["d-model"], count: 8 }], "test");
  const hostFile = join(fx.location.dir, HOST_FILE_NAME);
  writePrivateFile(hostFile, JSON.stringify({ train, test }, null, 2));

  const trainDigest = digestOf(train.map((s) => s.scenario_id));
  const roundResults: ScenarioResult[][] = PLAN.map((plan) =>
    toResults(train, verdictsFor(train, new Set(plan.passing), new Set(plan.flaky))),
  );
  const rounds = roundResults.map((results, index) => {
    const result = released(
      releaseFeedback(fx.ledger, { goalId: fx.goalId, workId, runId: runIdOf(index + 1), trainDigest, results }),
    );
    return {
      text: result.feedback.text,
      kinds: result.host_only.categories.map((category) => category.kind),
      units: result.host_only.disclosure_units,
    };
  });

  const testDigest = digestOf(test.map((s) => s.scenario_id));
  const testRun = { goalId: fx.goalId, workId, runId: runIdOf(9), testDigest, candidateSha: CANDIDATE_SHA };
  beginTestRun(fx.ledger, { ...testRun, testTotal: test.length });
  completeTestRun(fx.ledger, { ...testRun, pass: 6, total: 8, flaky: 1 });
  authorizeTestReseal(fx.ledger, { goalId: fx.goalId, workId, basis: "J6" }, "human:dev");

  const events: LedgerEvent[] = fx.ledger.readVerified();
  const counts = trainCounts(roundResults[2] ?? []);
  const sealedTest = sealedTestField(testRunStateFromEvents(events, fx.goalId, workId), testDigest, CANDIDATE_SHA);
  const evidence = feedbackEvidenceFiles({
    goalId: fx.goalId,
    workId,
    runId: runIdOf(9),
    events,
    train: counts,
    test: { pass: 6, total: 8, flaky: 1 },
    noise: noiseCheck({ k: 3, flaky_train: counts.flaky, flaky_test: 1 }),
    now: new Date("2026-10-14T10:00:00.000Z"),
  });

  setReading(fx, CANARY.nextReading);
  const tick2 = requireOk("second tick", tickCli(fx, ["--json"]));
  const status = requireOk("goal status", omf(["goal", "status", fx.goalId, "--json"], fx.repo, fx.home));
  const list = requireOk("work list", omf(["work", "list", fx.goalId, "--json"], fx.repo, fx.home));

  return {
    fx,
    workId,
    train,
    test,
    hostFile,
    rounds,
    trainCounts: counts,
    noise: noiseCheck({ k: 3, flaky_train: counts.flaky, flaky_test: 1 }),
    sealedTest,
    evidence,
    tick1,
    tick2,
    status,
    list,
  };
}
