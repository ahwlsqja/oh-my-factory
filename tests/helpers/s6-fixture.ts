import { declareBudget } from "../../src/core/budget.js";
import type { DecisionClass } from "../../src/decision/types.js";
import type { ImplementerFeedback } from "../../src/feedback/release.js";
import type { RoundScenario, RoundVerdict, ScenarioTally } from "../../src/judge/round.js";
import { type TestJudge, s6Station } from "../../src/judge/s6-station.js";
import type { FeedbackSlot, RoundState } from "../../src/judge/state.js";
import type { ScenarioSplit, StoredKind } from "../../src/scenario/types.js";
import { type EvidenceInputs, classifyOutcome, emptyEvidenceInputs } from "../../src/work/classify.js";
import { aggregateGates } from "../../src/work/gates.js";
import { STATION_IDS, type StationId, type StationStatus } from "../../src/work/line-types.js";
import type { Station, StationContext } from "../../src/work/sequencer.js";
import type { LineFixture } from "./line.js";
import { RUN_1 } from "./test-run.js";

export const CANDIDATE = "1".repeat(40);
export const TRAIN_DIGEST = "a".repeat(64);
export const TEST_DIGEST = "b".repeat(64);

export type Verdict = ScenarioTally["verdict"];
const OUTCOMES: Record<Verdict, ScenarioTally["outcomes"]> = {
  pass: ["pass", "pass", "pass"],
  fail: ["fail", "fail", "fail"],
  flaky: ["pass", "fail", "pass"],
  error: ["error", "error", "error"],
};

/** `n` becomes the 16-hex scenario ref, so every scenario of a test has its own handle. */
export function scenario(
  n: number,
  split: ScenarioSplit,
  kind: StoredKind = "behavior",
  category: DecisionClass = "interface",
): RoundScenario {
  const scenario_ref = n.toString(16).padStart(16, "0");
  return { scenario_ref, split, kind, category, set: { scenario_ref, steps: [] } };
}

export const TRAIN = [1, 2, 3, 4, 5, 6].map((n) => scenario(n, "train"));
export const TEST = [7, 8, 9, 10].map((n) => scenario(n, "test"));
export const TRAIN_CANARY = scenario(11, "train", "contradiction_canary");
export const TEST_CANARY = scenario(12, "test", "contradiction_canary");

export function verdictOf(
  phase: "train" | "test",
  scenarios: readonly RoundScenario[],
  verdicts: readonly Verdict[],
): RoundVerdict {
  const tallies = scenarios.map((s, i): ScenarioTally => {
    const verdict = verdicts[i] ?? "pass";
    return {
      scenario_ref: s.scenario_ref,
      category: s.category,
      kind: s.kind,
      outcomes: OUTCOMES[verdict],
      verdict,
    };
  });
  const behavior = tallies.filter((t) => t.kind === "behavior");
  const canaries = tallies.filter((t) => t.kind === "contradiction_canary");
  const count = (v: Verdict): number => behavior.filter((t) => t.verdict === v).length;
  return {
    phase,
    k: 3,
    candidate_sha: CANDIDATE,
    tallies,
    counts: {
      total: behavior.length,
      pass: count("pass"),
      fail: count("fail"),
      flaky: count("flaky"),
      error: count("error"),
    },
    contradiction: { scenarios: canaries.length, rejected: canaries.filter((t) => t.verdict === "fail").length },
    harness_context_sha256: "c".repeat(64),
    sut_base_digest: `sha256:${"d".repeat(64)}`,
    harness_base_digest: `sha256:${"e".repeat(64)}`,
  };
}

/**
 * The state S4 and S5 leave for S6. `trainVerdicts` scores the six train scenarios (the train canary is always
 * rejected, as a working judge would); anything else is overridden through `over`. S6 never reads the lease: only the
 * container judge passes it on.
 */
export function roundState(trainVerdicts: readonly Verdict[] = [], over: Partial<RoundState> = {}): RoundState {
  const verdicts = TRAIN.map((_, i) => trainVerdicts[i] ?? "pass");
  return {
    round: 1,
    candidate_sha: CANDIDATE,
    lease: {} as RoundState["lease"],
    run: ["node", "dist/cache.js"],
    train: verdictOf("train", [...TRAIN, TRAIN_CANARY], [...verdicts, "fail"]),
    test: null,
    trainDigest: TRAIN_DIGEST,
    testDigest: TEST_DIGEST,
    scenarios: [...TRAIN, ...TEST, TRAIN_CANARY, TEST_CANARY],
    flawed_signal: false,
    ...over,
  };
}

export interface SlotSpy extends FeedbackSlot {
  puts: string[];
}

export function slot(): SlotSpy {
  let held: ImplementerFeedback | null = null;
  const puts: string[] = [];
  return {
    puts,
    put(feedback, text) {
      held = feedback;
      puts.push(text);
    },
    take() {
      const out = held;
      held = null;
      return out;
    },
    released: () => puts,
  };
}

export const typesOf = (l: LineFixture): string[] => l.events().map((event) => event.type);

/** The split-spending events, in ledger order. */
export const spentOf = (l: LineFixture): string[] =>
  typesOf(l).filter((type) => type.startsWith("feedback.test_run") || type === "judge.round_completed");

export function declareDisclosure(l: LineFixture, units: number): void {
  declareBudget(l.fx.ledger, l.fx.goalId, "disclosure", units, "human:dev");
}

export interface JudgeSpy {
  judge: TestJudge;
  /** The scenarios each call was asked to judge. */
  calls: RoundScenario[][];
  /** The ledger's event types at the moment each call started. */
  seen: string[][];
}

/** A judge that answers the test split with `verdicts` (default pass) and records what it was asked. */
export function judgeSpy(l: LineFixture, verdicts: readonly Verdict[] = []): JudgeSpy {
  const calls: RoundScenario[][] = [];
  const seen: string[][] = [];
  const judge: TestJudge = async ({ scenarios }) => {
    calls.push([...scenarios]);
    seen.push(typesOf(l));
    return verdictOf("test", scenarios, verdicts);
  };
  return { judge, calls, seen };
}

export function stationOf(
  l: LineFixture,
  state: RoundState | null,
  judgeTest: TestJudge,
  feedback: FeedbackSlot,
): Station {
  return s6Station({ location: l.fx.location, current: () => state, feedback, judgeTest });
}

export function contextOf(l: LineFixture, inputs: EvidenceInputs = cleanInputs(), round = 1): StationContext {
  return {
    runId: RUN_1,
    workId: l.workId,
    goalId: l.fx.goalId,
    round,
    resumed: false,
    entryState: "ready",
    item: l.item(),
    now: l.clock.now,
    inputs,
    recordSpend: () => undefined,
  };
}

/** Everything a clean line leaves before S6 except the test split: S4 scored the train split 6/6, S5 found nothing. */
export function cleanInputs(): EvidenceInputs {
  const inputs = emptyEvidenceInputs();
  inputs.audit = { canary_hits: 0, tests_edited: false, prove_test: "pass", judge_config_touched: false };
  inputs.sealed = { train: { pass: 6, total: 6, flaky: 0 }, test: "not run" };
  inputs.isolation_level = "L2";
  inputs.high_risk_paths_touched = [];
  inputs.gate_line = "OMF_GATES fast=pass full=pass deep=skip";
  inputs.gate_verdict = "GREEN";
  return inputs;
}

/** The real classifier over a line whose stations all answered ok and whose gates all passed. */
export function classifyLine(inputs: EvidenceInputs) {
  const stations = Object.fromEntries(STATION_IDS.map((id) => [id, "ok"])) as Record<StationId, StationStatus>;
  const gates = aggregateGates({ "GATE-1": "pass", "GATE-2": "pass", "GATE-3": "pass", "GATE-4": "pass" });
  return classifyOutcome({
    stop: { kind: "none" },
    stations,
    gates,
    inputs,
    decisions_unmeasured: [],
    gate4_warnings: [],
    injected_gates: [],
    declared_level: "L2",
  });
}
