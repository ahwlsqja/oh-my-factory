import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { declareBudget } from "../../src/core/budget.js";
import { Ledger } from "../../src/core/ledger.js";
import {
  authorizeTestReseal,
  beginTestRun,
  completeTestRun,
  feedbackEntryCheck,
  planTestRun,
  sealedTestField,
  testRunBlock,
} from "../../src/feedback/test-run.js";
import { dispositionOf } from "../../src/work/outcome.js";
import { runChild } from "../helpers/child.js";
import { DIGEST_A, DIGEST_B, GOAL, RUN_1, RUN_2, SHA_1, SHA_2, WORK, codeOf, stateOf } from "../helpers/test-run.js";
import { makeTempDir } from "../helpers/tmp.js";

const TEST_RUN_MODULE = resolve("dist/feedback/test-run.js");
const LEDGER_MODULE = resolve("dist/core/ledger.js");

/** Child: tries to consume the one test split. Exit 0 = consumed, 3 = refused as already consumed, 1 = anything else. */
const CHILD = `
const { beginTestRun } = await import(process.argv[1]);
const { Ledger } = await import(process.argv[2]);
const [dir, goalId, workId, runId, testDigest, candidateSha] = process.argv.slice(3);
try {
  beginTestRun(new Ledger(dir), { goalId, workId, runId, testDigest, candidateSha, testTotal: 10 });
  process.exit(0);
} catch (err) {
  process.exit(err?.code === "test_already_consumed" ? 3 : 1);
}
`;

const BEGIN_A = { goalId: GOAL, workId: WORK, runId: RUN_1, testDigest: DIGEST_A, candidateSha: SHA_1, testTotal: 10 };
const COMPLETE_A = {
  goalId: GOAL,
  workId: WORK,
  runId: RUN_1,
  testDigest: DIGEST_A,
  candidateSha: SHA_1,
  pass: 8,
  total: 10,
  flaky: 0,
};

// Spec §5.5 to §5.8, M3d-D11: the sealed test split is consumed once per work item and test digest, as a ledger fact.
// Known limits (spec §8): truncating the end of the ledger is not detected, and a person who can write ~/.omf can forge
// a `human:*` authorization (v0.1 signatures are not cryptographic).
describe("W-test-split-once", () => {
  it("lets exactly one of four racing processes consume the split", async () => {
    const dir = makeTempDir("omf-w-split-once-");
    const runs = await Promise.all(
      [1, 2, 3, 4].map((i) =>
        runChild(CHILD, [
          TEST_RUN_MODULE,
          LEDGER_MODULE,
          dir,
          GOAL,
          WORK,
          `r-20261014T09150${i}Z-ab12`,
          DIGEST_A,
          SHA_1,
        ]),
      ),
    );
    expect(runs.map((r) => r.code).sort()).toEqual([0, 3, 3, 3]);
    const ledger = new Ledger(dir);
    expect(ledger.readVerified().filter((e) => e.type === "feedback.test_run_consumed")).toHaveLength(1);
    expect(stateOf(ledger).runs).toHaveLength(1);
  });

  it("survives a restart and reads a recorded result only for the commit it was measured on", () => {
    const ledger = new Ledger(makeTempDir("omf-w-split-once-"));
    beginTestRun(ledger, BEGIN_A);
    completeTestRun(ledger, COMPLETE_A);

    const restarted = new Ledger(ledger.dir);
    const state = stateOf(restarted);
    expect(planTestRun(state, DIGEST_A, SHA_1)).toEqual({
      action: "use_recorded",
      result: { pass: 8, total: 10, flaky: 0 },
    });
    expect(planTestRun(state, DIGEST_A, SHA_2)).toEqual({ action: "needs_reseal" });
    expect(sealedTestField(state, DIGEST_A, SHA_2)).toBe("consumed_other_candidate");
    // Nothing runs the consumed split again: not for the same commit, not for another one, not from a restarted process.
    expect(codeOf(() => beginTestRun(restarted, BEGIN_A))).toBe("test_already_consumed");
    expect(codeOf(() => beginTestRun(restarted, { ...BEGIN_A, candidateSha: SHA_2 }))).toBe("test_already_consumed");
  });
});

// A run that consumed the split and never completed (a crash, a killed process) is a blocked outcome, not a silent re-run.
describe("W-test-run-incomplete-blocked", () => {
  it("blocks at entry and at the test station, maps to a re-enterable park, and reopens only through a person plus a fresh digest", () => {
    const ledger = new Ledger(makeTempDir("omf-w-incomplete-"));
    declareBudget(ledger, GOAL, "disclosure", 3, "human:dev");
    beginTestRun(ledger, BEGIN_A); // consumed, then "crashed": no completeTestRun

    const plan = planTestRun(stateOf(ledger), DIGEST_A, SHA_1);
    expect(plan).toEqual({ action: "blocked", reason: "test_run_incomplete" });
    const block = testRunBlock(plan);
    expect(block).toEqual({ outcome: "blocked", reason_code: "test_run_incomplete" });
    if (block === null) throw new Error("expected a block");
    expect(dispositionOf({ ...block, exhausted: false })).toEqual({
      action: "park",
      item_state: "unchanged",
      counts_toward_stop_if: false,
    });
    expect(feedbackEntryCheck(ledger.readVerified(), GOAL, WORK, DIGEST_A, SHA_1)).toEqual({
      status: "blocked",
      reason_code: "test_run_incomplete",
    });
    expect(sealedTestField(stateOf(ledger), DIGEST_A, SHA_1)).toBe("consumed_incomplete");

    // No path around the person: the same digest, a fresh digest, and an authorization by omf all fail.
    expect(codeOf(() => beginTestRun(ledger, { ...BEGIN_A, runId: RUN_2 }))).toBe("test_already_consumed");
    expect(codeOf(() => beginTestRun(ledger, { ...BEGIN_A, runId: RUN_2, testDigest: DIGEST_B }))).toBe(
      "reseal_not_authorized",
    );
    expect(codeOf(() => authorizeTestReseal(ledger, { goalId: GOAL, workId: WORK, basis: "J6" }, "omf"))).toBe(
      "forbidden",
    );

    authorizeTestReseal(ledger, { goalId: GOAL, workId: WORK, basis: "J6" }, "human:dev");
    expect(feedbackEntryCheck(ledger.readVerified(), GOAL, WORK, DIGEST_B, SHA_1)).toEqual({ status: "proceed" });
    beginTestRun(ledger, { ...BEGIN_A, runId: RUN_2, testDigest: DIGEST_B });
    expect(codeOf(() => beginTestRun(ledger, BEGIN_A))).toBe("test_already_consumed"); // the old digest stays consumed
    expect(sealedTestField(stateOf(ledger), DIGEST_A, SHA_1)).toBe("consumed_incomplete");
  });
});
