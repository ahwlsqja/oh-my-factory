import { NotGoldenError } from "../container/measure.js";
import { canonicalize, sha256Hex } from "../core/canonical-json.js";
import { Ledger } from "../core/ledger.js";
import type { ProjectLocation } from "../core/paths.js";
import { noiseCheck } from "../feedback/noise.js";
import { type WithheldReason, releaseFeedback } from "../feedback/release.js";
import {
  type TestResult,
  beginTestRun,
  completeTestRun,
  evidenceSealedTest,
  noiseCheckField,
  planTestRun,
  sealedTestField,
  testRunBlock,
  testRunStateFromEvents,
} from "../feedback/test-run.js";
import { FeedbackError } from "../feedback/types.js";
import type { Station, StationContext, StationResult } from "../work/sequencer.js";
import type { ReasonCode } from "../work/w-events.js";
import { judgeRoundEvent } from "./events.js";
import { roundFacts, toScenarioResults, writeTallyView } from "./results.js";
import type { RoundScenario, RoundVerdict } from "./round.js";
import type { FeedbackSlot, RoundState } from "./state.js";

/**
 * Judges the test split of the round in the container. A port, so the station is tested without a daemon; the real
 * adapter is `containerTestJudge`. It gets the behavior scenarios of the test split only: the contradiction canaries of
 * both splits were already judged by S4 and are not the split's single use.
 */
export type TestJudge = (input: {
  ctx: StationContext;
  state: RoundState;
  scenarios: readonly RoundScenario[];
}) => Promise<RoundVerdict>;

export interface S6StationDeps {
  /** S6 reads only the ledger directory; the container judge needs the whole location. */
  location: Pick<ProjectLocation, "dir">;
  /** The state S4 and S5 left for this round; null when S4 of this round did not run. */
  current: () => RoundState | null;
  feedback: FeedbackSlot;
  judgeTest: TestJudge;
}

const blocked = (reason_code: ReasonCode): StationResult => ({ kind: "blocked", reason_code });
const manual = (): StationResult => ({ kind: "manual", reason_code: "manual_required" });

/**
 * A withheld release as the line's closed stop. An exhausted or undeclared disclosure budget needs a person
 * to declare or raise it (J8); a spent exposure limit or a train batch too small to release needs new scenarios (J3).
 */
export function withheldResult(reason: WithheldReason): StationResult {
  switch (reason) {
    case "disclosure_exhausted":
      return blocked("disclosure_unavailable");
    case "exposure_limit":
    case "too_few_scenarios":
      return blocked("scenarios_exhausted");
  }
}

/**
 * The feedback writers' errors as closed stops. A malformed call or a sequence the writers never produce is
 * not retryable, so it parks for a person (`manual_required`). A budget or ledger integrity error is not a
 * FeedbackError and is never mapped here: it propagates and the sequencer records a station error.
 */
export function feedbackErrorResult(err: FeedbackError): StationResult {
  switch (err.code) {
    case "not_declared":
      return blocked("disclosure_unavailable");
    case "no_train_scenarios":
      return blocked("scenarios_exhausted");
    case "reseal_not_authorized":
      return blocked("test_reseal_required");
    case "test_already_consumed":
      return blocked("test_run_incomplete");
    case "invalid_input":
    case "invalid_event":
    case "no_open_test_run":
    case "nothing_to_reseal":
    case "already_authorized":
    case "forbidden":
      return manual();
  }
}

/** v0.1 never evaluates variance, so this is `not_evaluated` whatever the counts (owner decision O-1). */
function setNoise(ctx: StationContext, state: RoundState, flakyTest: number | null): void {
  ctx.inputs.noise_check = noiseCheckField(
    noiseCheck({ k: state.train.k, flaky_train: state.train.counts.flaky, flaky_test: flakyTest }),
  );
}

/** The scores only (category, size, pass count): a repeated score gives the same digest, so GATE-4 can see a stall. */
function rework(deps: S6StationDeps, ctx: StationContext, state: RoundState, ledger: Ledger): StationResult {
  const released = releaseFeedback(ledger, {
    goalId: ctx.goalId,
    workId: ctx.workId,
    runId: ctx.runId,
    trainDigest: state.trainDigest,
    results: toScenarioResults(state.train.tallies),
  });
  if (released.status === "withheld") return withheldResult(released.reason);
  deps.feedback.put(released.feedback, released.feedback.text);
  const scores = released.host_only.categories.map(({ category, n, pass }) => ({ category, n, pass }));
  return { kind: "rework", progress_digest: sha256Hex(canonicalize(scores)) };
}

/**
 * The single use of the test split. `beginTestRun` writes the consumption before anything runs, so a crash or a judge
 * failure leaves "consumed, incomplete" and the next run is blocked until a person acts (M3d). A split with no behavior
 * scenario fails `beginTestRun` as invalid input: zero is never a pass.
 */
async function testSplit(
  deps: S6StationDeps,
  ctx: StationContext,
  state: RoundState,
  ledger: Ledger,
): Promise<StationResult> {
  const folded = () => testRunStateFromEvents(ledger.readVerified(), ctx.goalId, ctx.workId);
  const plan = planTestRun(folded(), state.testDigest, state.candidate_sha);
  const block = testRunBlock(plan);
  if (block !== null) return blocked(block.reason_code);

  let result: TestResult;
  if (plan.action === "use_recorded") {
    result = plan.result;
  } else {
    const scenarios = state.scenarios.filter((s) => s.split === "test" && s.kind === "behavior");
    const run = {
      goalId: ctx.goalId,
      workId: ctx.workId,
      runId: ctx.runId,
      testDigest: state.testDigest,
      candidateSha: state.candidate_sha,
    };
    beginTestRun(ledger, { ...run, testTotal: scenarios.length });
    let verdict: RoundVerdict;
    try {
      verdict = await deps.judgeTest({ ctx, state, scenarios });
    } catch (err) {
      // Closed codes only: the message may hold anything. A container that is not golden is J7; every other fault is the environment.
      return blocked(err instanceof NotGoldenError ? "gate_blocked" : "infra_failure");
    }
    ledger.append(
      judgeRoundEvent(
        { goal_id: ctx.goalId, work_id: ctx.workId, run_id: ctx.runId, round: ctx.round },
        roundFacts(verdict),
      ),
    );
    writeTallyView(ctx.item.dir, {
      runId: ctx.runId,
      round: ctx.round,
      phase: "test",
      candidateSha: state.candidate_sha,
      tallies: verdict.tallies,
    });
    state.test = verdict;
    // `pass` counts scenarios that passed in every repetition, so a flaky test scenario leaves pass < total.
    result = { pass: verdict.counts.pass, total: verdict.counts.total, flaky: verdict.counts.flaky };
    completeTestRun(ledger, { ...run, ...result });
  }
  ctx.inputs.sealed.test = evidenceSealedTest(sealedTestField(folded(), state.testDigest, state.candidate_sha));
  setNoise(ctx, state, result.flaky);
  return { kind: "ok", progress_digest: sha256Hex(canonicalize({ train: state.train.counts, test: result })) };
}

/**
 * S6 (spec §5.5 to §5.8), in this order:
 * 1. a flawed signal from S5 spends nothing and returns ok: the classifier reads the line as flawed without the split;
 * 2. a failing train scenario releases masked feedback and asks for another round (`rework`);
 * 3. a flaky train scenario with no failure returns ok without a run: the classifier reads `flaky_scenario`;
 * 4. a clean train batch spends the test split, or reuses the result recorded for this commit.
 * It runs after GATE-3, which the sequencer guarantees by `LINE_ORDER`. A missing state, the state of another round or
 * an empty train batch is a station error that stops the line (fail closed).
 */
export function s6Station(deps: S6StationDeps): Station {
  return {
    id: "S6",
    async run(ctx) {
      const state = deps.current();
      if (state === null || state.round !== ctx.round || state.train.counts.total === 0) {
        return blocked("station_error");
      }
      const ledger = new Ledger(deps.location.dir, ctx.now);
      try {
        if (state.flawed_signal) {
          setNoise(ctx, state, null);
          return { kind: "ok" };
        }
        if (state.train.counts.fail > 0) return rework(deps, ctx, state, ledger);
        if (state.train.counts.flaky > 0) {
          setNoise(ctx, state, null);
          return { kind: "ok" };
        }
        return await testSplit(deps, ctx, state, ledger);
      } catch (err) {
        if (err instanceof FeedbackError) return feedbackErrorResult(err);
        throw err;
      }
    },
  };
}
