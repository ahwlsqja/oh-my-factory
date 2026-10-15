import { declareBudget } from "../../src/core/budget.js";
import { beginTestRun, completeTestRun } from "../../src/feedback/test-run.js";
import type { CandidateRef, CandidateSource } from "../../src/judge/candidate.js";
import { splitDigest } from "../../src/vault/vault.js";
import { emptyEvidenceInputs } from "../../src/work/classify.js";
import type { StationContext } from "../../src/work/sequencer.js";
import { HUMAN } from "./decision-fixture.js";
import type { SealedItem } from "./scenario-fixture.js";

export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);
export const RUN = "r-20261014T000000Z-0001";
const AT = new Date("2026-10-14T00:00:00.000Z");

/** A candidate whose quarantine is never opened: the stations under test only pass it on. */
export function candidateRef(head: string = SHA_A): CandidateRef {
  const quarantine = { gitDir: "/nonexistent/quarantine.git" };
  return { quarantine, base: "0".repeat(40), head, explicitTestPaths: [], surfaces: [] };
}

export interface CandidateDouble extends CandidateSource {
  calls: number;
}

export function candidateDouble(ref: CandidateRef | null): CandidateDouble {
  const double: CandidateDouble = {
    calls: 0,
    async current() {
      double.calls += 1;
      return ref;
    },
  };
  return double;
}

export function stationCtx(s: SealedItem, over: Partial<StationContext> = {}): StationContext {
  return {
    runId: RUN,
    workId: s.f.workId,
    goalId: s.f.scope.goal_id,
    round: 0,
    resumed: false,
    entryState: "ready",
    item: s.f.item,
    now: () => AT,
    inputs: emptyEvidenceInputs(),
    recordSpend: () => {},
    ...over,
  };
}

/** A person declares the goal's disclosure budget (J8). */
export function declareDisclosure(s: SealedItem, units = 5): void {
  declareBudget(s.f.fx.ledger, s.f.scope.goal_id, "disclosure", units, HUMAN);
}

/** Consumes the test split for `sha`; with `complete` also records a result (1 of 1 passed). */
export function consumeTest(s: SealedItem, sha: string, complete: boolean): void {
  const input = {
    goalId: s.f.scope.goal_id,
    workId: s.f.workId,
    runId: RUN,
    testDigest: splitDigest(s.scenarios, new Map(), "test"),
    candidateSha: sha,
  };
  beginTestRun(s.f.fx.ledger, { ...input, testTotal: 1 });
  if (complete) completeTestRun(s.f.fx.ledger, { ...input, pass: 1, total: 1, flaky: 0 });
}
