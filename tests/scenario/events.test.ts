import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/core/ledger.js";
import type { NewEvent } from "../../src/core/ledger.js";
import {
  foldSeals,
  gate2EvaluatedEvent,
  nextSealRound,
  scenarioStatusChangedEvent,
  sealCompletedEvent,
  sealFailedEvent,
  sealRequestedEvent,
} from "../../src/scenario/events.js";
import { scenarioRef } from "../../src/scenario/types.js";
import { OTHER_SCOPE, SCOPE } from "../helpers/decision.js";
import { AUTHOR, COUNTS, digest, sealId, storedScenario } from "../helpers/stored-scenario.js";
import { makeTempDir } from "../helpers/tmp.js";

const newLedger = (): Ledger => new Ledger(makeTempDir("omf-ledger-"));

const COMPLETED_BODY = {
  round: 1,
  seal_id: sealId(1),
  author: AUTHOR,
  decisions_digest: digest("a"),
  set_sha256: digest("1"),
  counts: COUNTS,
  rejected_by_code: { schema_invalid: 1 },
};

/** A valid seal.completed for seal number `n`; its set digest is `n` repeated, so each seal is distinguishable. */
const completed = (n: number, round: number, scope = SCOPE): NewEvent =>
  sealCompletedEvent(scope, { ...COMPLETED_BODY, round, seal_id: sealId(n), set_sha256: digest(String(n)) });

describe("seal and gate2 event builders", () => {
  it("build valid omf events that hold codes, counts, digests and refs only", () => {
    const planted = storedScenario(7);
    const events = [
      sealRequestedEvent(SCOPE, {
        round: 1,
        author: AUTHOR,
        input_sha256: digest("b"),
        decisions_digest: digest("a"),
        feedback: { unlinked_decision_ids: ["d-cache", "d-queue"], weak: 1, contradictions: 0, invalid: 2 },
      }),
      completed(1, 1),
      sealFailedEvent(SCOPE, { round: 2, code: "timeout", duration_ms: 12 }),
      scenarioStatusChangedEvent(SCOPE, {
        seal_id: sealId(1),
        scenario_id: planted.scenario_id,
        status: "contaminated",
        reason: "canary_hit",
      }),
      gate2EvaluatedEvent(SCOPE, {
        round: 1,
        seal_id: sealId(1),
        status: "fail",
        route: "back_to_S2",
        reason_codes: ["unlinked_decisions"],
        unlinked_decision_ids: ["d-cache"],
        not_run_decision_ids: ["d-latency"],
        counts: { active: 2, behavior_train: 1, behavior_test: 1, canaries: 0, contaminated: 0, retired: 0 },
        set_sha256: digest("1"),
        decisions_digest: digest("a"),
      }),
    ];
    for (const event of events) expect(event.actor).toBe("omf");
    const text = JSON.stringify(events);
    for (const secret of [planted.scenario_id, planted.canary, "item-7", "adding item 7"]) {
      expect(text, "no scenario text reaches an event").not.toContain(secret);
    }
    expect(text).toContain(scenarioRef(planted.scenario_id));
    expect(events[0]!.payload["feedback"]).toEqual({ unlinked_decision_count: 2, weak: 1, contradictions: 0, invalid: 2 });
    expect(events[0]!.payload["author"], "the request names vendor, model and isolation, not a time").toEqual({
      vendor: "command",
      model: "stub",
      isolation: "host_command",
    });
    expect(text, "feedback reaches the ledger as a count, never as ids").not.toContain("d-queue");
  });

  it("refuses a payload that does not validate", () => {
    expect(() => sealFailedEvent(SCOPE, { round: 0, code: "timeout", duration_ms: 1 })).toThrow(/invalid seal\.failed payload/);
    expect(() => sealCompletedEvent(SCOPE, { ...COMPLETED_BODY, seal_id: "../escape" })).toThrow(/invalid seal\.completed payload/);
    expect(
      () => sealCompletedEvent(SCOPE, { ...COMPLETED_BODY, rejected_by_code: { "free text here": 1 } }),
      "a rejection key is a code, never prose",
    ).toThrow(/invalid seal\.completed payload/);
    expect(() =>
      sealRequestedEvent(SCOPE, {
        round: 1,
        author: { vendor: "co\nmmand", model: "stub", isolation: "host_command" },
        input_sha256: digest("b"),
        decisions_digest: digest("a"),
        feedback: null,
      }),
    ).toThrow(/invalid seal\.requested payload/);
  });
});

describe("foldSeals", () => {
  it("counts valid omf events of one scope and reports every invalid one as an anomaly", () => {
    const ledger = newLedger();
    const scoped = { goal_id: SCOPE.goal_id, work_id: SCOPE.work_id };
    ledger.append(sealFailedEvent(SCOPE, { round: 1, code: "no_output", duration_ms: 1 }));
    ledger.append(completed(1, 1));
    ledger.append(completed(2, 2));
    ledger.append(completed(3, 1, OTHER_SCOPE)); // another item: skipped without a trace
    ledger.append({ ...completed(4, 3), actor: "human:dev@example.invalid" }); // not omf: ignored
    ledger.append({ actor: "omf", type: "seal.completed", payload: { ...scoped, round: "one" } }); // invalid payload
    ledger.append({ actor: "omf", type: "seal.bogus", payload: { ...scoped } }); // unknown seal.* type
    ledger.append(completed(2, 3)); // a second seal.completed for seal 2

    const events = ledger.readVerified();
    const fold = foldSeals(events, SCOPE);
    expect(fold.completed).toBe(2);
    expect(fold.failed).toBe(1);
    expect(fold.anomalies, "invalid payload, unknown type and the repeated seal id").toBe(3);
    expect(fold.records.map((record) => record.seal_id)).toEqual([sealId(1), sealId(2)]);
    expect(fold.latest).toMatchObject({
      seal_id: sealId(2),
      round: 2,
      set_sha256: digest("2"),
      decisions_digest: digest("a"),
      author: AUTHOR,
      counts: COUNTS,
    });
    expect(fold.latest!.seq).toBeGreaterThan(fold.records[0]!.seq);
    expect(nextSealRound(events, SCOPE), "a failed seal consumes no round").toBe(3);
    expect(foldSeals(events, OTHER_SCOPE).completed).toBe(1);
  });

  it("is empty for a ledger with no seal events", () => {
    expect(foldSeals([], SCOPE)).toEqual({ latest: null, completed: 0, failed: 0, anomalies: 0, records: [] });
    expect(nextSealRound([], SCOPE)).toBe(1);
  });
});
