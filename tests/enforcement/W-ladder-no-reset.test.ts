import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BudgetError, budgetConsumedEvent, declareBudget, raiseBudget } from "../../src/core/budget.js";
import { Ledger } from "../../src/core/ledger.js";
import {
  type FeedbackEvent,
  exposureUnitsOf,
  feedbackEvent,
  ladderStateFromEvents,
} from "../../src/feedback/events.js";
import { FeedbackError } from "../../src/feedback/types.js";
import { releaseFeedback } from "../../src/feedback/release.js";
import { runChild } from "../helpers/child.js";
import { ledgerEvents, setupEnforcementGoal, tickCli, useCleanModel } from "../helpers/enforcement-goal.js";
import {
  DIGEST,
  GOAL,
  RUN,
  WORK,
  counts,
  declaredLedger,
  eventsOf,
  releaseInput,
  remaining,
} from "../helpers/release-fixture.js";

// Spec §5.7: releases are counted per goal in the host ledger and bounded by the `disclosure` budget (J8). The W twin of
// E3: a restart, a new process, another work item, a changed train digest or a G re-seed cannot reset the count, the
// baseline of a set or the exposure count; only a person raises the pool (J8) or restarts the exposure count (J3).
// Known limit (spec §8): removing events from the end of the ledger is not detected.

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof FeedbackError ? err.code : "not a FeedbackError";
  }
  return undefined;
}

const RELEASE_MODULE = resolve("dist/feedback/release.js");
const LEDGER_MODULE = resolve("dist/core/ledger.js");

/** Child: one release of ten interface scenarios with `argv[4]` passing, in a fresh process. Prints {status, detail}. */
const CHILD = `
const [, releaseModule, ledgerModule, dir, pass] = process.argv;
const { releaseFeedback } = await import(releaseModule);
const { Ledger } = await import(ledgerModule);
const results = Array.from({ length: 10 }, (_, i) => ({ category: "interface", passed: i < Number(pass), flaky: false }));
const out = releaseFeedback(new Ledger(dir), {
  goalId: ${JSON.stringify(GOAL)}, workId: ${JSON.stringify(WORK)}, runId: ${JSON.stringify(RUN)}, trainDigest: ${JSON.stringify(DIGEST)}, results,
});
console.log(JSON.stringify(out.status === "withheld" ? { status: out.status, detail: out.reason } : { status: out.status, detail: out.host_only.categories[0].kind }));
`;

async function releaseInNewProcess(ledger: Ledger, pass: number): Promise<{ status: string; detail: string }> {
  const run = await runChild(CHILD, [RELEASE_MODULE, LEDGER_MODULE, ledger.dir, String(pass)]);
  expect(run.code).toBe(0);
  return JSON.parse(run.out.trim()) as { status: string; detail: string };
}

describe("W-ladder-no-reset", () => {
  it("a new process keeps the best released score and the pool", async () => {
    const ledger = declaredLedger(2);
    releaseFeedback(ledger, releaseInput(counts({ interface: [0, 10] })));
    expect(await releaseInNewProcess(ledger, 4)).toEqual({ status: "released", detail: "new" });
    expect(remaining(new Ledger(ledger.dir))).toBe(0);
    expect(await releaseInNewProcess(ledger, 8)).toEqual({ status: "withheld", detail: "disclosure_exhausted" });
    expect(await releaseInNewProcess(ledger, 4)).toEqual({ status: "released", detail: "repeat" });

    const events = new Ledger(ledger.dir).readVerified();
    const state = ladderStateFromEvents(events, GOAL, DIGEST);
    expect(state.best.get("interface")).toEqual({ pass: 4, n: 10 });
    expect(state.releases).toBe(3);
    expect(exposureUnitsOf(events, GOAL, WORK)).toBe(2);
  });

  it("two work items of one goal draw from one pool until it is gone, then both new scores are withheld", () => {
    const ledger = declaredLedger(3);
    const a = { workId: "w-aaaaaaaaaaaa", trainDigest: "a".repeat(64) };
    const b = { workId: "w-bbbbbbbbbbbb", trainDigest: "b".repeat(64) };
    const at = (item: typeof a, pass: number) =>
      releaseFeedback(ledger, releaseInput(counts({ interface: [pass, 10] }), item));
    expect(at(a, 0).status).toBe("released");
    expect(at(b, 0).status).toBe("released");
    expect(at(a, 4).status).toBe("released");
    expect(remaining(ledger)).toBe(0);
    expect(at(b, 4)).toEqual({ status: "withheld", reason: "disclosure_exhausted" });
    expect(at(a, 8)).toEqual({ status: "withheld", reason: "disclosure_exhausted" });
    expect(at(a, 4).status).toBe("released");
    const events = ledger.readVerified();
    expect([exposureUnitsOf(events, GOAL, a.workId), exposureUnitsOf(events, GOAL, b.workId)]).toEqual([2, 1]);
  });

  it("a changed digest alone keeps the exposure count of the work item; a J6 act does not restart it, a J3 act does", () => {
    const ledger = declaredLedger(10);
    const at = (digest: string, results: ReturnType<typeof counts>) =>
      releaseFeedback(ledger, releaseInput(results, { trainDigest: digest, exposureLimit: 2 }));
    expect(at(DIGEST, counts({ interface: [0, 10] })).status).toBe("released");
    expect(at(DIGEST, counts({ interface: [4, 10] })).status).toBe("released");

    // A scenario was retired, so the digest and n changed. The fresh baseline does not buy fresh exposure.
    const retired = "b".repeat(64);
    expect(at(retired, counts({ interface: [0, 9] }))).toEqual({ status: "withheld", reason: "exposure_limit" });

    ledger.append(
      feedbackEvent(
        {
          type: "feedback.test_reseal_authorized",
          payload: { goal_id: GOAL, work_id: WORK, consumed_test_digest: "c".repeat(64), basis: "J6" },
        },
        "human:dev",
      ),
    );
    expect(exposureUnitsOf(ledger.readVerified(), GOAL, WORK)).toBe(2);
    expect(at(retired, counts({ interface: [0, 9] }))).toEqual({ status: "withheld", reason: "exposure_limit" });

    ledger.append(
      feedbackEvent(
        {
          type: "feedback.test_reseal_authorized",
          payload: { goal_id: GOAL, work_id: WORK, consumed_test_digest: null, basis: "J3" },
        },
        "human:dev",
      ),
    );
    expect(exposureUnitsOf(ledger.readVerified(), GOAL, WORK)).toBe(0);
    expect(at(retired, counts({ interface: [0, 9] })).status).toBe("released");
    expect(exposureUnitsOf(ledger.readVerified(), GOAL, WORK)).toBe(1);
  });

  it("a second declaration cannot refill the pool and omf cannot raise it; a person can", () => {
    const ledger = declaredLedger(1);
    releaseFeedback(ledger, releaseInput(counts({ interface: [0, 10] })));
    const dueNewScore = () => releaseFeedback(ledger, releaseInput(counts({ interface: [4, 10] })));
    expect(dueNewScore()).toEqual({ status: "withheld", reason: "disclosure_exhausted" });
    expect(() => declareBudget(ledger, GOAL, "disclosure", 9, "human:dev")).toThrow(BudgetError);
    expect(() => raiseBudget(ledger, GOAL, "disclosure", 1, "omf")).toThrow(BudgetError);
    expect(dueNewScore()).toEqual({ status: "withheld", reason: "disclosure_exhausted" });
    raiseBudget(ledger, GOAL, "disclosure", 1, "human:dev");
    expect(dueNewScore().status).toBe("released");
  });
});

describe("W-ladder-no-reset: one disclosure pool for the goal loop and the W loop (M3d-D8)", () => {
  it("a release that takes the last unit stops the next re-seed before the model is called", () => {
    const fx = setupEnforcementGoal({ rounds: 5, disclosure: 1 });
    useCleanModel(fx);
    const released = releaseFeedback(fx.ledger, releaseInput(counts({ interface: [0, 5] }), { goalId: fx.goalId }));
    expect(released.status).toBe("released");
    expect(remaining(fx.ledger, fx.goalId)).toBe(0);

    const tick = tickCli(fx, ["--json"]);
    expect(tick.code).toBe(1);
    expect((JSON.parse(tick.stdout) as { escalation: unknown }).escalation).toMatchObject({
      j: "J8",
      reason_code: "disclosure_exhausted",
    });
    expect(ledgerEvents(fx, "reconcile.requested")).toHaveLength(0);
  });

  it("a re-seed that takes the last unit withholds the next new score and writes no release", () => {
    const fx = setupEnforcementGoal({ rounds: 5, disclosure: 1 });
    useCleanModel(fx);
    expect(tickCli(fx).code).toBe(0);
    expect(remaining(fx.ledger, fx.goalId)).toBe(0);

    const result = releaseFeedback(fx.ledger, releaseInput(counts({ interface: [0, 5] }), { goalId: fx.goalId }));
    expect(result).toEqual({ status: "withheld", reason: "disclosure_exhausted" });
    expect(ledgerEvents(fx, "feedback.released")).toHaveLength(0);
  });
});

describe("W-ladder-no-reset: forged ladder events stop the line", () => {
  const forged: FeedbackEvent = {
    type: "feedback.released",
    payload: {
      goal_id: GOAL,
      work_id: WORK,
      run_id: RUN,
      train_digest: DIGEST,
      round: 2,
      // 11 of 110 after 1 of 110 is a gain of 10 passes, below the integer margin, so "new" is a lie.
      categories: [{ category: "interface", n: 110, pass: 11, score_pct: 10, kind: "new" }],
      disclosure_units: 1,
    },
  };

  it("a 'new' score below the margin, even with its unit, makes the next release throw invalid_event and write nothing", () => {
    const ledger = declaredLedger(5);
    releaseFeedback(ledger, releaseInput(counts({ interface: [1, 110] })));
    ledger.appendWithMany(() => [budgetConsumedEvent(GOAL, "disclosure", 1), feedbackEvent(forged, "omf")]);
    const before = ledger.readVerified().length;
    expect(codeOf(() => releaseFeedback(ledger, releaseInput(counts({ interface: [12, 110] }))))).toBe("invalid_event");
    expect(ledger.readVerified()).toHaveLength(before);
    expect(remaining(ledger)).toBe(3);
  });

  it("a release event written by anyone but omf stops the goal's line", () => {
    const ledger = declaredLedger(5);
    ledger.append({ actor: "agent:codex", type: forged.type, payload: { ...forged.payload } });
    expect(codeOf(() => releaseFeedback(ledger, releaseInput(counts({ interface: [3, 5] }))))).toBe("invalid_event");
    expect(eventsOf(ledger, "feedback.released")).toHaveLength(1);
    expect(remaining(ledger)).toBe(5);
  });
});
