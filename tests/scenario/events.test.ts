import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/core/ledger.js";
import type { NewEvent } from "../../src/core/ledger.js";
import {
  ScenarioStatusError,
  authorPrecedesStart,
  effectiveScenarios,
  foldSeals,
  foldStatuses,
  gate2EvaluatedEvent,
  markScenarioStatus,
  nextSealRound,
  sealFeedbackFromEvents,
  scenarioStatusChangedEvent,
  sealCompletedEvent,
  sealFailedEvent,
  sealRequestedEvent,
} from "../../src/scenario/events.js";
import { scenarioRef } from "../../src/scenario/types.js";
import type { StoredScenario } from "../../src/scenario/types.js";
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
        feedback_counts: { weak: 1, contradictions: 0, invalid: 2 },
      }),
    ];
    for (const event of events) expect(event.actor).toBe("omf");
    const text = JSON.stringify(events);
    for (const secret of [planted.scenario_id, planted.canary, "item-7", "adding item 7"]) {
      expect(text, "no scenario text reaches an event").not.toContain(secret);
    }
    expect(text).toContain(scenarioRef(planted.scenario_id));
    expect(events[0]!.payload["feedback"]).toEqual({
      unlinked_decision_count: 2,
      weak: 1,
      contradictions: 0,
      invalid: 2,
    });
    expect(events[0]!.payload["author"], "the request names vendor, model and isolation, not a time").toEqual({
      vendor: "command",
      model: "stub",
      isolation: "host_command",
    });
    expect(text, "feedback reaches the ledger as a count, never as ids").not.toContain("d-queue");
  });

  it("refuses a payload that does not validate", () => {
    expect(() => sealFailedEvent(SCOPE, { round: 0, code: "timeout", duration_ms: 1 })).toThrow(
      /invalid seal\.failed payload/,
    );
    expect(() => sealCompletedEvent(SCOPE, { ...COMPLETED_BODY, seal_id: "../escape" })).toThrow(
      /invalid seal\.completed payload/,
    );
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

function statusCode(fn: () => void): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof ScenarioStatusError ? err.code : "not a ScenarioStatusError";
  }
  return undefined;
}

describe("scenario status", () => {
  it("comes from omf ledger events only, and moves away from active once", () => {
    const ledger = newLedger();
    ledger.append(completed(1, 1));
    const [first, second, third] = [storedScenario(1), storedScenario(2), storedScenario(3)] as [
      StoredScenario,
      StoredScenario,
      StoredScenario,
    ];

    markScenarioStatus(ledger, SCOPE, sealId(1), first.scenario_id, "retired", "person_retired");
    markScenarioStatus(ledger, SCOPE, sealId(1), second.scenario_id, "contaminated", "canary_hit");
    const written = ledger.readVerified().length;
    expect(
      statusCode(() => markScenarioStatus(ledger, SCOPE, sealId(1), first.scenario_id, "contaminated", "canary_hit")),
    ).toBe("already_moved");
    expect(
      statusCode(() => markScenarioStatus(ledger, SCOPE, sealId(9), third.scenario_id, "retired", "person_retired")),
    ).toBe("unknown_seal");
    expect(ledger.readVerified().length, "a refused move appends nothing").toBe(written);

    // Someone else appending the event does not move a status.
    ledger.append({
      actor: "agent:worker",
      type: "scenario.status_changed",
      payload: {
        ...SCOPE,
        seal_id: sealId(1),
        scenario_ref: scenarioRef(third.scenario_id),
        status: "retired",
        reason: "person_retired",
      },
    });
    // A second omf move of an already moved scenario is an anomaly, and the first move stands.
    ledger.append(
      scenarioStatusChangedEvent(SCOPE, {
        seal_id: sealId(1),
        scenario_id: first.scenario_id,
        status: "contaminated",
        reason: "canary_hit",
      }),
    );

    const events = ledger.readVerified();
    const { statuses, anomalies } = foldStatuses(events, SCOPE, sealId(1));
    expect(anomalies).toBe(1);
    expect(statuses.get(scenarioRef(first.scenario_id))).toBe("retired");
    expect(effectiveScenarios([first, second, third], statuses).map((e) => e.status)).toEqual([
      "retired",
      "contaminated",
      "active",
    ]);
    expect(foldStatuses(events, SCOPE, sealId(2)).statuses.size, "status is per seal").toBe(0);
    expect(foldStatuses(events, OTHER_SCOPE, sealId(1)).statuses.size, "status is per item").toBe(0);
  });

  it("counts an invalid omf scenario event as an anomaly", () => {
    const ledger = newLedger();
    const scoped = { goal_id: SCOPE.goal_id, work_id: SCOPE.work_id };
    ledger.append({
      actor: "omf",
      type: "scenario.status_changed",
      payload: { ...scoped, seal_id: sealId(1), status: "retired" },
    });
    ledger.append({ actor: "omf", type: "scenario.exposed", payload: { ...scoped } });
    expect(foldStatuses(ledger.readVerified(), SCOPE, sealId(1)).anomalies).toBe(2);
  });

  it("is ledger-else-active whatever a file says", () => {
    const edited = { ...storedScenario(4), status: "retired", exposure: 99 } as unknown as StoredScenario;
    expect(effectiveScenarios([edited], new Map()).map((e) => e.status)).toEqual(["active"]);
    const retired = new Map([[scenarioRef(edited.scenario_id), "retired" as const]]);
    expect(effectiveScenarios([edited], retired).map((e) => e.status)).toEqual(["retired"]);
  });
});

describe("authorPrecedesStart", () => {
  const started = (actor = "omf", scope = SCOPE): NewEvent => ({
    actor,
    type: "work.started",
    payload: { goal_id: scope.goal_id, work_id: scope.work_id, run_id: "r-20261014T000000Z-ab12", from: "ready" },
  });
  const orderOf = (events: NewEvent[]) => {
    const ledger = newLedger();
    for (const event of events) ledger.append(event);
    return authorPrecedesStart(ledger.readVerified(), SCOPE);
  };

  it.each([
    ["no seal and no start", () => [], { ok: true }],
    ["a seal, then the start", () => [completed(1, 1), started()], { ok: true }],
    [
      "a start of another item is not this item's start",
      () => [started("omf", OTHER_SCOPE), completed(1, 1)],
      { ok: true },
    ],
    ["a start and no seal at all", () => [started()], { ok: false, reason: "no_seal" }],
    ["the start, then a seal", () => [started(), completed(1, 1)], { ok: false, reason: "seal_after_start" }],
    [
      "a reseal after the start",
      () => [completed(1, 1), started(), completed(2, 2)],
      { ok: false, reason: "seal_after_start" },
    ],
    [
      "a forged start by a person before the seal fails closed",
      () => [started("human:dev@example.invalid"), completed(1, 1)],
      { ok: false, reason: "seal_after_start" },
    ],
  ])("%s", (_name, events, expected) => {
    expect(orderOf(events())).toEqual(expected);
  });
});

describe("sealFeedbackFromEvents", () => {
  const evaluated = (over: Partial<Parameters<typeof gate2EvaluatedEvent>[1]> = {}, scope = SCOPE): NewEvent =>
    gate2EvaluatedEvent(scope, {
      round: 1,
      seal_id: sealId(1),
      status: "fail",
      route: "back_to_S2",
      reason_codes: ["unlinked_decisions"],
      unlinked_decision_ids: ["d-cache"],
      not_run_decision_ids: [],
      counts: { active: 2, behavior_train: 1, behavior_test: 1, canaries: 0, contaminated: 0, retired: 0 },
      set_sha256: digest("1"),
      decisions_digest: digest("a"),
      feedback_counts: { weak: 1, contradictions: 0, invalid: 2 },
      ...over,
    });
  const read = (events: NewEvent[]) => {
    const ledger = newLedger();
    for (const event of events) ledger.append(event);
    return sealFeedbackFromEvents(ledger.readVerified(), SCOPE);
  };

  it("rebuilds the feedback of the latest back_to_S2 evaluation after the latest completed seal", () => {
    expect(read([completed(1, 1), evaluated()])).toEqual({
      unlinked_decision_ids: ["d-cache"],
      weak: 1,
      contradictions: 0,
      invalid: 2,
    });
    expect(
      read([
        completed(1, 1),
        evaluated(),
        evaluated({ unlinked_decision_ids: ["d-queue"], feedback_counts: { weak: 0, contradictions: 3, invalid: 0 } }),
      ]),
    ).toEqual({
      unlinked_decision_ids: ["d-queue"],
      weak: 0,
      contradictions: 3,
      invalid: 0,
    });
  });

  it("counts every evaluation when no seal has completed", () => {
    expect(read([evaluated()])).not.toBeNull();
  });

  it("is null for an evaluation that precedes the latest seal, for a pass and for other routes", () => {
    expect(read([completed(1, 1), evaluated(), completed(2, 2)])).toBeNull();
    expect(read([completed(1, 1)])).toBeNull();
    expect(
      read([
        completed(1, 1),
        evaluated({ status: "pass", route: null, reason_codes: [], unlinked_decision_ids: [], feedback_counts: null }),
      ]),
    ).toBeNull();
    expect(
      read([
        completed(1, 1),
        evaluated({ route: "J3", reason_codes: ["probe_error"], unlinked_decision_ids: [], feedback_counts: null }),
      ]),
    ).toBeNull();
  });

  it("canary_missing adds no field: the counts stay three integers", () => {
    const missing = evaluated({
      reason_codes: ["canary_missing"],
      unlinked_decision_ids: [],
      feedback_counts: { weak: 0, contradictions: 0, invalid: 0 },
    });
    expect(read([completed(1, 1), missing])).toEqual({
      unlinked_decision_ids: [],
      weak: 0,
      contradictions: 0,
      invalid: 0,
    });
  });

  it("ignores another item, a non-omf actor and a payload that fails the schema", () => {
    const forged = { ...evaluated(), actor: "human:dev@example.invalid" };
    const broken: NewEvent = {
      actor: "omf",
      type: "gate2.evaluated",
      payload: { goal_id: SCOPE.goal_id, work_id: SCOPE.work_id, round: "x" },
    };
    expect(read([completed(1, 1), evaluated({}, OTHER_SCOPE), forged, broken])).toBeNull();
  });
});
