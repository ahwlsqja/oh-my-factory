import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/core/ledger.js";
import { validate } from "../../src/core/schema.js";
import { contradictionState } from "../../src/gate/gate3.js";
import {
  type JudgeRoundFacts,
  contradictionVerdictOf,
  foldJudgeRounds,
  imageCheck,
  judgeRoundEvent,
} from "../../src/judge/events.js";
import { fakeEvent } from "../helpers/evidence-fixture.js";
import { makeTempDir } from "../helpers/tmp.js";

const SHA = "a".repeat(40);
const SCOPE1 = { goal_id: "g-fast", work_id: "w-0123456789ab", run_id: "r-20261014T091500Z-ab12", round: 1 };
const ROUND2 = { ...SCOPE1, round: 2 };
const FACTS: JudgeRoundFacts = {
  phase: "train",
  candidate_sha: SHA,
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
const DRIFT = { harness_context_sha256: "9".repeat(64) };

/** A ledger-shaped event built by the real writer. */
const at = (seq: number, scope: typeof SCOPE1, facts: JudgeRoundFacts, actor = "omf") =>
  fakeEvent(seq, "judge.round_completed", judgeRoundEvent(scope, facts).payload, actor);

describe("judgeRoundEvent", () => {
  it("is an omf event of ids, counts and digests that a ledger accepts", () => {
    const event = judgeRoundEvent(SCOPE1, FACTS);
    expect(event).toEqual({ actor: "omf", type: "judge.round_completed", payload: { ...SCOPE1, ...FACTS } });
    const ledger = new Ledger(makeTempDir("omf-judge-event-"));
    expect(ledger.append(event)).toMatchObject({ seq: 1, actor: "omf", type: "judge.round_completed" });
    expect(ledger.verify()).toMatchObject({ ok: true, count: 1 });
  });

  it("refuses a sha that is not hex, counts that do not add up, a k of 1, too many rejections, and an extra key", () => {
    const refused = /invalid judge\.round_completed event/;
    expect(() => judgeRoundEvent(SCOPE1, { ...FACTS, candidate_sha: "XYZ" })).toThrow(refused);
    expect(() => judgeRoundEvent(SCOPE1, { ...FACTS, pass: 3 })).toThrow(refused);
    expect(() => judgeRoundEvent(SCOPE1, { ...FACTS, k: 1 })).toThrow(refused);
    expect(() => judgeRoundEvent(SCOPE1, { ...FACTS, contradiction_rejected: 2 })).toThrow(refused);
    const extra = { ...judgeRoundEvent(SCOPE1, FACTS).payload, scenario_ref: "0123456789abcdef" };
    expect(validate("gate-event.schema.json", { type: "judge.round_completed", payload: extra }).ok).toBe(false);
  });
});

describe("foldJudgeRounds and imageCheck", () => {
  it("fold reads only schema-valid events of actor omf that name the item", () => {
    const events = [
      at(1, SCOPE1, FACTS),
      at(2, SCOPE1, { ...FACTS, phase: "test" }, "agent:forger"),
      fakeEvent(3, "judge.round_completed", { ...judgeRoundEvent(SCOPE1, FACTS).payload, k: 1 }),
      at(4, { ...SCOPE1, work_id: "w-ba9876543210" }, FACTS),
    ];
    expect(foldJudgeRounds(events, SCOPE1).map((payload) => payload.phase)).toEqual(["train"]);
  });

  it("matches while the digests hold, flags a change inside the run, and ignores a forged event", () => {
    const same = [at(1, SCOPE1, FACTS), at(2, ROUND2, { ...FACTS, phase: "test" })];
    expect([imageCheck(same, SCOPE1), imageCheck(same, ROUND2)]).toEqual(["match", "match"]);
    for (const drift of [DRIFT, { sut_base_digest: `sha256:${"4".repeat(64)}` }]) {
      expect(imageCheck([at(1, SCOPE1, FACTS), at(2, ROUND2, { ...FACTS, ...drift })], ROUND2)).toBe("mismatch");
    }
    const forged = [at(1, SCOPE1, FACTS), at(2, SCOPE1, { ...FACTS, ...DRIFT }, "agent:forger")];
    expect(imageCheck(forged, SCOPE1)).toBe("match");
  });

  it("is not_run without an event for the round, and a later run pins afresh", () => {
    expect([imageCheck([], SCOPE1), imageCheck([at(1, SCOPE1, FACTS)], ROUND2)]).toEqual(["not_run", "not_run"]);
    const next = { ...SCOPE1, run_id: "r-20261015T080000Z-cd34" };
    const events = [at(1, SCOPE1, FACTS), at(2, next, { ...FACTS, ...DRIFT })];
    expect([imageCheck(events, SCOPE1), imageCheck(events, next)]).toEqual(["match", "match"]);
  });
});

describe("contradictionVerdictOf", () => {
  it("reads the train phase of the round, the only phase that judges the canaries", () => {
    const verdict = contradictionVerdictOf([at(1, SCOPE1, FACTS)], SCOPE1);
    expect(verdict).toEqual({ judged_sha: SHA, contradiction_scenarios: 1, rejected: 1 });
    expect([contradictionState(verdict, SHA), contradictionState(verdict, "b".repeat(40))]).toEqual([
      "failing",
      "not_run",
    ]);
    expect(contradictionVerdictOf([at(1, SCOPE1, { ...FACTS, phase: "test" })], SCOPE1)).toBeNull();
    expect(contradictionVerdictOf([at(1, SCOPE1, FACTS)], ROUND2)).toBeNull();
  });

  it("is null when two train events of one round disagree", () => {
    const events = [at(1, SCOPE1, FACTS), at(2, SCOPE1, { ...FACTS, contradiction_rejected: 0 })];
    expect(contradictionVerdictOf(events, SCOPE1)).toBeNull();
  });
});
