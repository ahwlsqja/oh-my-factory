import { type RoundScope, type WorkAudit, recordAudit } from "../../src/audit/work-audit.js";
import { gatesEvaluatedEvent } from "../../src/gate/events.js";
import type { GateLineValues } from "../../src/gate/gate-line.js";
import { recordStageMeasurement } from "../../src/isolation/record.js";
import { ISOLATION_STAGES, type IsolationLevel, type IsolationStage } from "../../src/isolation/types.js";
import { type JudgeRoundFacts, judgeRoundEvent } from "../../src/judge/events.js";
import { sealCompletedEvent } from "../../src/scenario/events.js";
import { emptyEvidenceInputs } from "../../src/work/classify.js";
import type { GateContext } from "../../src/work/gates.js";
import { HEAD_SHA } from "./audit-diff-fixture.js";
import { type DecisionFixture, NOW, setupDecisionItem } from "./decision-fixture.js";
import { ALL_L2, GREEN_LINE, RUN, cleanAudit, gateRunOf, measurement } from "./gate3-parts.js";

export const FACTS: JudgeRoundFacts = {
  phase: "train",
  candidate_sha: HEAD_SHA,
  k: 3,
  scenarios_total: 4,
  pass: 2,
  fail: 1,
  flaky: 1,
  error: 0,
  contradiction_scenarios: 1,
  contradiction_rejected: 1,
  harness_context_sha256: "1".repeat(64),
  sut_base_digest: `sha256:${"2".repeat(64)}`,
  harness_base_digest: `sha256:${"3".repeat(64)}`,
};

export interface Gate3Fixture {
  f: DecisionFixture;
  scope(round?: number): RoundScope;
  ctx(round?: number, over?: Partial<GateContext>): GateContext;
  audit(round: number, report: WorkAudit, head: string): void;
  gates(round: number, values: GateLineValues): void;
  judge(round: number, over: Partial<JudgeRoundFacts>): void;
  stages(round: number, levels: Partial<Record<IsolationStage, IsolationLevel>>): void;
}

/** A decision item whose ledger holds nothing of the round until a test (or `arrangeHealthy`) records it. */
export function setupGate3(): Gate3Fixture {
  const f = setupDecisionItem();
  const ledger = f.fx.ledger;
  const scope = (round = 1): RoundScope => ({ goal_id: f.scope.goal_id, work_id: f.scope.work_id, run_id: RUN, round });
  return {
    f,
    scope,
    ctx: (round = 1, over = {}) => ({
      location: f.fx.location,
      item: f.item,
      events: ledger.readVerified(),
      now: NOW,
      runId: RUN,
      round,
      resumed: false,
      inputs: emptyEvidenceInputs(),
      ...over,
    }),
    audit: (round, report, head) => recordAudit(ledger, scope(round), f.item.dir, report, head),
    gates: (round, values) =>
      void ledger.append(gatesEvaluatedEvent(scope(round), gateRunOf(values, ["fast", "full"]))),
    judge: (round, over) => void ledger.append(judgeRoundEvent(scope(round), { ...FACTS, ...over })),
    stages(round, levels) {
      for (const stage of ISOLATION_STAGES) {
        const level = levels[stage];
        if (level === undefined) continue;
        if (stage !== "author") {
          recordStageMeasurement(ledger, scope(round), f.item.dir, measurement(stage, level));
          continue;
        }
        const set_sha256 = "5".repeat(64);
        const counts = {
          authored: 1,
          stored: 1,
          behavior: 1,
          contradiction_canary: 0,
          train: 1,
          test: 0,
          rejected: 0,
          ignored_fields: 0,
        };
        const seal = ledger.append(
          sealCompletedEvent(f.scope, {
            round: 1,
            seal_id: "seal-0123456789abcdef",
            author: { vendor: "claude", model: "m1", at: "2026-10-14T09:00:00Z", isolation: "container" },
            decisions_digest: "a".repeat(64),
            set_sha256,
            counts,
            rejected_by_code: {},
          }),
        );
        recordStageMeasurement(ledger, scope(round), f.item.dir, measurement("author", level), {
          seal_seq: seal.seq,
          set_sha256,
        });
      }
    },
  };
}

/** What to leave out or break. The default is a healthy round 1 with all four stages measured L2; `null` records nothing. */
export interface Arrangement {
  round?: number;
  audit?: WorkAudit | null;
  head?: string;
  gates?: GateLineValues | null;
  judge?: Partial<JudgeRoundFacts> | null;
  /** A second judge event of the run (test phase, same round) that may carry a drifted digest. */
  extraJudge?: Partial<JudgeRoundFacts>;
  levels?: Partial<Record<IsolationStage, IsolationLevel>>;
}

/** The test appends the author and implementer measurements itself: no station measures them yet, so a pass here is a seam. */
export function arrangeHealthy(g: Gate3Fixture, o: Arrangement = {}): void {
  const round = o.round ?? 1;
  if (o.audit !== null) g.audit(round, o.audit ?? cleanAudit(), o.head ?? HEAD_SHA);
  if (o.gates !== null) g.gates(round, o.gates ?? GREEN_LINE);
  if (o.judge !== null) g.judge(round, o.judge ?? {});
  if (o.extraJudge !== undefined) g.judge(round, { phase: "test", ...o.extraJudge });
  g.stages(round, o.levels ?? ALL_L2);
}
