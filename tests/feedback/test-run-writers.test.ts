import { describe, expect, it } from "vitest";
import { authorizeTestReseal, beginTestRun, completeTestRun } from "../../src/feedback/test-run.js";
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
  codeOf,
  newLedger,
  stateOf,
} from "../helpers/test-run.js";

const BEGIN_A = { goalId: GOAL, workId: WORK, runId: RUN_1, testDigest: DIGEST_A, candidateSha: SHA_1, testTotal: 10 };
const COMPLETE_A = { goalId: GOAL, workId: WORK, runId: RUN_1, testDigest: DIGEST_A, candidateSha: SHA_1, pass: 8, total: 10, flaky: 1 };
const RESEAL = { goalId: GOAL, workId: WORK, basis: "J3" as const };

describe("beginTestRun", () => {
  it("appends one consumption and refuses the same digest again, for any run or commit, writing nothing", () => {
    const ledger = newLedger();
    const event = beginTestRun(ledger, BEGIN_A);
    expect(event).toMatchObject({
      actor: "omf",
      type: "feedback.test_run_consumed",
      payload: { test_digest: DIGEST_A, candidate_sha: SHA_1, test_total: 10 },
    });
    const length = ledger.readVerified().length;
    expect(codeOf(() => beginTestRun(ledger, { ...BEGIN_A, runId: RUN_2 }))).toBe("test_already_consumed");
    expect(codeOf(() => beginTestRun(ledger, { ...BEGIN_A, candidateSha: SHA_2 }))).toBe("test_already_consumed");
    expect(ledger.readVerified()).toHaveLength(length);
  });

  it("refuses another digest without a person's authorization and a test_total below 1, writing nothing", () => {
    const ledger = newLedger();
    beginTestRun(ledger, BEGIN_A);
    const length = ledger.readVerified().length;
    expect(codeOf(() => beginTestRun(ledger, { ...BEGIN_A, runId: RUN_2, testDigest: DIGEST_B }))).toBe("reseal_not_authorized");
    expect(codeOf(() => beginTestRun(newLedger(), { ...BEGIN_A, testTotal: 0 }))).toBe("invalid_input");
    expect(ledger.readVerified()).toHaveLength(length);
  });
});

describe("completeTestRun", () => {
  it("needs a matching open consumption, records the result once, and refuses counts the fold would refuse", () => {
    const ledger = newLedger();
    expect(codeOf(() => completeTestRun(ledger, COMPLETE_A))).toBe("no_open_test_run");
    beginTestRun(ledger, BEGIN_A);
    expect(codeOf(() => completeTestRun(ledger, { ...COMPLETE_A, runId: RUN_2 }))).toBe("no_open_test_run");
    expect(codeOf(() => completeTestRun(ledger, { ...COMPLETE_A, candidateSha: SHA_2 }))).toBe("no_open_test_run");
    const length = ledger.readVerified().length;
    for (const counts of [{ pass: 1, total: 9, flaky: 0 }, { pass: 11, total: 10, flaky: 0 }, { pass: 8, total: 10, flaky: 3 }]) {
      expect(codeOf(() => completeTestRun(ledger, { ...COMPLETE_A, ...counts })), JSON.stringify(counts)).toBe("invalid_input");
    }
    expect(ledger.readVerified()).toHaveLength(length);

    expect(completeTestRun(ledger, COMPLETE_A)).toMatchObject({
      actor: "omf",
      type: "feedback.test_run_completed",
      payload: { test_digest: DIGEST_A, candidate_sha: SHA_1, pass: 8, total: 10, flaky: 1 },
    });
    expect(stateOf(ledger).runs[0]).toMatchObject({ status: "completed", result: { pass: 8, total: 10, flaky: 1 } });
    expect(codeOf(() => completeTestRun(ledger, COMPLETE_A))).toBe("no_open_test_run");
  });
});

describe("authorizeTestReseal", () => {
  it("is for people only", () => {
    const ledger = newLedger();
    beginTestRun(ledger, BEGIN_A);
    for (const actor of ["omf", "agent:x"]) expect(codeOf(() => authorizeTestReseal(ledger, RESEAL, actor)), actor).toBe("forbidden");
    expect(stateOf(ledger).pending_authorization).toBeNull();
  });

  it("with nothing consumed allows only J3, which writes a null-digest authorization", () => {
    const ledger = newLedger();
    expect(codeOf(() => authorizeTestReseal(ledger, { ...RESEAL, basis: "J6" }, "human:dev"))).toBe("nothing_to_reseal");
    expect(authorizeTestReseal(ledger, RESEAL, "human:dev")).toMatchObject({
      actor: "human:dev",
      type: "feedback.test_reseal_authorized",
      payload: { consumed_test_digest: null, basis: "J3" },
    });
    // The null authorization does not let anything run twice: the first digest still just runs once.
    beginTestRun(ledger, BEGIN_A);
    expect(stateOf(ledger).pending_authorization).toBeNull();
  });

  it("names the latest consumed digest once, then a fresh digest runs once and the old ones stay consumed", () => {
    const ledger = newLedger();
    beginTestRun(ledger, BEGIN_A);
    completeTestRun(ledger, COMPLETE_A);
    expect(authorizeTestReseal(ledger, { ...RESEAL, basis: "J6" }, "human:dev")).toMatchObject({
      payload: { consumed_test_digest: DIGEST_A, basis: "J6" },
    });
    expect(codeOf(() => authorizeTestReseal(ledger, RESEAL, "human:dev"))).toBe("already_authorized");

    beginTestRun(ledger, { ...BEGIN_A, runId: RUN_2, testDigest: DIGEST_B });
    expect(codeOf(() => beginTestRun(ledger, { ...BEGIN_A, runId: RUN_2, testDigest: DIGEST_B }))).toBe("test_already_consumed");
    expect(codeOf(() => beginTestRun(ledger, BEGIN_A))).toBe("test_already_consumed");
    expect(codeOf(() => beginTestRun(ledger, { ...BEGIN_A, testDigest: DIGEST_C }))).toBe("reseal_not_authorized");
  });
});
