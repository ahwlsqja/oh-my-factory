import { describe, expect, it } from "vitest";
import { declareBudget } from "../../src/core/budget.js";
import type { Ledger } from "../../src/core/ledger.js";
import { noiseCheck, noiseReasonCode } from "../../src/feedback/noise.js";
import {
  type TestRunPlan,
  type TestRunState,
  feedbackEntryCheck,
  planTestRun,
  sealedTestField,
  testRunBlock,
} from "../../src/feedback/test-run.js";
import { dispositionOf } from "../../src/work/outcome.js";
import {
  DIGEST_A,
  DIGEST_B,
  DIGEST_C,
  GOAL,
  RUN_1,
  RUN_2,
  SHA_1,
  SHA_2,
  WORK,
  authorize,
  codeOf,
  complete,
  consume,
  newLedger,
  stateOf,
} from "../helpers/test-run.js";

const BLOCKED: TestRunPlan = { action: "blocked", reason: "test_run_incomplete" };
const RESEAL: TestRunPlan = { action: "needs_reseal" };

describe("planTestRun (M3d-D11)", () => {
  it("runs a never-consumed split, blocks a consumed one that has no result, and reuses a completed one", () => {
    const ledger = newLedger();
    expect(planTestRun(stateOf(ledger), DIGEST_A, SHA_1)).toEqual({ action: "run" });
    consume(ledger, DIGEST_A);
    for (const sha of [SHA_1, SHA_2, null]) expect(planTestRun(stateOf(ledger), DIGEST_A, sha)).toEqual(BLOCKED);
    complete(ledger, DIGEST_A);
    expect(planTestRun(stateOf(ledger), DIGEST_A, SHA_1)).toEqual({
      action: "use_recorded",
      result: { pass: 8, total: 10, flaky: 1 },
    });
  });

  it("binds a recorded result to its candidate: another or an unknown commit needs a reseal, never the old result", () => {
    const ledger = newLedger();
    consume(ledger, DIGEST_A, SHA_1);
    complete(ledger, DIGEST_A, SHA_1);
    const state = stateOf(ledger);
    expect(planTestRun(state, DIGEST_A, SHA_2)).toEqual(RESEAL);
    expect(planTestRun(state, DIGEST_A, null)).toEqual(RESEAL);
    expect(sealedTestField(state, DIGEST_A, SHA_1)).toEqual({ pass: 8, total: 10, flaky: 1 });
    expect(sealedTestField(state, DIGEST_A, SHA_2)).toBe("consumed_other_candidate");
    expect(sealedTestField(state, DIGEST_A, null)).toBe("consumed_other_candidate");
    expect(sealedTestField(state, DIGEST_B, SHA_1)).toBe("not yet run");
  });

  it("never reports a consumed split as not yet run", () => {
    const ledger = newLedger();
    expect(sealedTestField(stateOf(ledger), DIGEST_A, SHA_1)).toBe("not yet run");
    consume(ledger, DIGEST_A);
    expect(sealedTestField(stateOf(ledger), DIGEST_A, SHA_1)).toBe("consumed_incomplete");
  });

  it("lets a person's authorization open one fresh digest and never reopens a consumed one", () => {
    const ledger = newLedger();
    consume(ledger, DIGEST_A);
    complete(ledger, DIGEST_A);
    expect(planTestRun(stateOf(ledger), DIGEST_B, SHA_1)).toEqual(RESEAL);
    authorize(ledger, DIGEST_A);
    expect(planTestRun(stateOf(ledger), DIGEST_B, SHA_1)).toEqual({ action: "run" });
    // The authorization does not let the completed digest run again, for the same commit or another one.
    expect(planTestRun(stateOf(ledger), DIGEST_A, SHA_1)).toMatchObject({ action: "use_recorded" });
    expect(planTestRun(stateOf(ledger), DIGEST_A, SHA_2)).toEqual(RESEAL);
    // Consuming the fresh digest spends the authorization.
    consume(ledger, DIGEST_B, SHA_1, RUN_2);
    expect(stateOf(ledger).pending_authorization).toBeNull();
    expect(planTestRun(stateOf(ledger), DIGEST_C, SHA_1)).toEqual(RESEAL);
  });

  it("does not read a null-digest authorization as permission to run", () => {
    const ledger = newLedger();
    authorize(ledger, null);
    expect(stateOf(ledger).pending_authorization).toMatchObject({ consumed_test_digest: null, basis: "J3" });
    expect(planTestRun(stateOf(ledger), DIGEST_A, SHA_1)).toEqual({ action: "run" });
    const afterRun: TestRunState = {
      runs: [
        {
          test_digest: DIGEST_A,
          run_id: RUN_1,
          candidate_sha: SHA_1,
          consumed_seq: 1,
          status: "completed",
          result: { pass: 8, total: 10, flaky: 1 },
        },
      ],
      pending_authorization: { consumed_test_digest: null, basis: "J3", seq: 2 },
    };
    expect(planTestRun(afterRun, DIGEST_B, SHA_1)).toEqual(RESEAL);
  });
});

describe("testRunStateFromEvents refuses sequences the writers never produce", () => {
  const FORGED: Record<string, (ledger: Ledger) => void> = {
    "a digest consumed twice": (l) => {
      consume(l, DIGEST_A);
      consume(l, DIGEST_A, SHA_1, RUN_2);
    },
    "a second digest consumed without authorization": (l) => {
      consume(l, DIGEST_A);
      consume(l, DIGEST_B, SHA_1, RUN_2);
    },
    "a completion with no consumption": (l) => void complete(l, DIGEST_A),
    "a second completion": (l) => {
      consume(l, DIGEST_A);
      complete(l, DIGEST_A);
      complete(l, DIGEST_A);
    },
    "a completion for another candidate": (l) => {
      consume(l, DIGEST_A, SHA_1);
      complete(l, DIGEST_A, SHA_2);
    },
    "a completion whose total differs from the consumed total": (l) => {
      consume(l, DIGEST_A, SHA_1, RUN_1, 10);
      complete(l, DIGEST_A, SHA_1, RUN_1, { pass: 1, total: 9, flaky: 0 });
    },
    "a completion with pass above total": (l) => {
      consume(l, DIGEST_A);
      complete(l, DIGEST_A, SHA_1, RUN_1, { pass: 11, total: 10, flaky: 0 });
    },
    "a completion with flaky above total minus pass": (l) => {
      consume(l, DIGEST_A);
      complete(l, DIGEST_A, SHA_1, RUN_1, { pass: 8, total: 10, flaky: 3 });
    },
    "an authorization written by omf": (l) => {
      consume(l, DIGEST_A);
      authorize(l, DIGEST_A, "J3", "omf");
    },
    "an authorization naming another digest": (l) => {
      consume(l, DIGEST_A);
      authorize(l, DIGEST_B);
    },
    "an authorization naming a digest before any run": (l) => void authorize(l, DIGEST_A),
    "a null authorization after a consumed run": (l) => {
      consume(l, DIGEST_A);
      authorize(l, null);
    },
    "a J6 authorization that names no run": (l) => void authorize(l, null, "J6"),
    "a second authorization while one is pending": (l) => {
      consume(l, DIGEST_A);
      authorize(l, DIGEST_A);
      authorize(l, DIGEST_A);
    },
  };

  for (const [name, build] of Object.entries(FORGED)) {
    it(`stops the line on ${name}`, () => {
      const ledger = newLedger();
      build(ledger);
      expect(codeOf(() => stateOf(ledger))).toBe("invalid_event");
    });
  }
});

describe("blocked outcomes and the noise downgrade reach dispositionOf", () => {
  const blockOf = (plan: TestRunPlan): NonNullable<ReturnType<typeof testRunBlock>> => {
    const block = testRunBlock(plan);
    if (block === null) throw new Error("expected a block");
    return block;
  };

  it("maps blocked and needs_reseal to blocked outcomes with their codes, and run and use_recorded to none", () => {
    expect(testRunBlock(BLOCKED)).toEqual({ outcome: "blocked", reason_code: "test_run_incomplete" });
    expect(testRunBlock(RESEAL)).toEqual({ outcome: "blocked", reason_code: "test_reseal_required" });
    expect(testRunBlock({ action: "run" })).toBeNull();
    expect(testRunBlock({ action: "use_recorded", result: { pass: 1, total: 1, flaky: 0 } })).toBeNull();
    for (const plan of [BLOCKED, RESEAL]) {
      // Both park the item without failing it, so re-entry works once a person has acted (M3b1-D7).
      expect(dispositionOf({ ...blockOf(plan), exhausted: false })).toEqual({
        action: "park",
        item_state: "unchanged",
        counts_toward_stop_if: false,
      });
    }
  });

  it("turns a forced noise check into a flawed outcome that submits as not_recommended", () => {
    const code = noiseReasonCode(noiseCheck({ k: 1, flaky_train: 0, flaky_test: null }));
    expect(code).toBe("noise_unverified");
    expect(noiseReasonCode(noiseCheck({ k: 3, flaky_train: 1, flaky_test: null }))).toBe("flaky_scenario");
    expect(dispositionOf({ outcome: "flawed", exhausted: false, reason_code: "noise_unverified" })).toMatchObject({
      action: "submit",
      recommendation: "not_recommended",
    });
  });
});

describe("feedbackEntryCheck (M3d-D12)", () => {
  it("parks before any station when no disclosure budget is declared, even for a state that would otherwise proceed", () => {
    const ledger = newLedger();
    expect(feedbackEntryCheck(ledger.readVerified(), GOAL, WORK, DIGEST_A, SHA_1)).toEqual({ status: "not_declared" });
    consume(ledger, DIGEST_A);
    expect(feedbackEntryCheck(ledger.readVerified(), GOAL, WORK, DIGEST_A, SHA_1)).toEqual({ status: "not_declared" });
  });

  const STATES: [string, (l: Ledger) => void, string, string | null, ReturnType<typeof feedbackEntryCheck>][] = [
    ["nothing consumed", () => undefined, DIGEST_A, SHA_1, { status: "proceed" }],
    ["consumed, no result", (l) => void consume(l, DIGEST_A), DIGEST_A, SHA_1, { status: "blocked", reason_code: "test_run_incomplete" }],
    [
      "completed for this commit",
      (l) => {
        consume(l, DIGEST_A);
        complete(l, DIGEST_A);
      },
      DIGEST_A,
      SHA_1,
      { status: "proceed" },
    ],
    [
      "completed for another commit",
      (l) => {
        consume(l, DIGEST_A);
        complete(l, DIGEST_A);
      },
      DIGEST_A,
      SHA_2,
      { status: "blocked", reason_code: "test_reseal_required" },
    ],
    [
      "completed, commit unknown",
      (l) => {
        consume(l, DIGEST_A);
        complete(l, DIGEST_A);
      },
      DIGEST_A,
      null,
      { status: "blocked", reason_code: "test_reseal_required" },
    ],
    [
      "another digest, no authorization",
      (l) => {
        consume(l, DIGEST_A);
        complete(l, DIGEST_A);
      },
      DIGEST_B,
      SHA_1,
      { status: "blocked", reason_code: "test_reseal_required" },
    ],
    [
      "another digest, authorized",
      (l) => {
        consume(l, DIGEST_A);
        complete(l, DIGEST_A);
        authorize(l, DIGEST_A);
      },
      DIGEST_B,
      SHA_1,
      { status: "proceed" },
    ],
  ];

  for (const [name, setup, digest, sha, expected] of STATES) {
    it(`agrees with the late planTestRun plus testRunBlock when ${name}`, () => {
      const ledger = newLedger();
      declareBudget(ledger, GOAL, "disclosure", 3, "human:dev");
      setup(ledger);
      const block = testRunBlock(planTestRun(stateOf(ledger), digest, sha));
      const late = block === null ? { status: "proceed" } : { status: "blocked", reason_code: block.reason_code };
      expect(feedbackEntryCheck(ledger.readVerified(), GOAL, WORK, digest, sha)).toEqual(late);
      expect(late).toEqual(expected);
    });
  }
});
