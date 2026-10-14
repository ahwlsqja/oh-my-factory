import { describe, expect, it } from "vitest";
import type { NewEvent } from "../../src/core/ledger.js";
import { decisionsDigest, findDecision, foldDecisions } from "../../src/decision/state.js";
import {
  CONTRACT,
  DECISION_AT,
  DEFERRAL_EXPIRES,
  HUMAN,
  MEASURE,
  NOISE,
  OTHER_SCOPE,
  SCOPE,
  addedEvent,
  deferredEvent,
  eventsOf,
  naEvent,
  rawDecisionEvent,
  rejectedEvent,
  resolvedEvent,
} from "../helpers/decision.js";

const fold = (...events: NewEvent[]) => foldDecisions(eventsOf(...events), SCOPE);

describe("foldDecisions", () => {
  it("folds an add and a human resolution into a resolved record", () => {
    const state = fold(
      addedEvent("d-cache", { class: "latency", question: "How fast must a warm render be?" }),
      resolvedEvent("d-cache", { rejected: ["no cache", "disk cache"], response_measure: MEASURE }),
    );
    expect(state.anomalies).toEqual([]);
    expect(state.decisions).toEqual([
      {
        id: "d-cache",
        class: "latency",
        question: "How fast must a warm render be?",
        qas: null,
        response_measure: MEASURE,
        status: "resolved",
        resolution: {
          choice: "memoize per input",
          rationale: "Repeated layout work dominates the slow path.",
          rejected: ["no cache", "disk cache"],
          by: HUMAN,
          at: DECISION_AT,
        },
        deferral: null,
        interface: null,
        na: null,
        added_by: "omf",
        added_seq: 1,
        closed_seq: 2,
        measure_seq: 2,
      },
    ]);
    expect(findDecision(state, "d-cache")).toBe(state.decisions[0]);
    expect(findDecision(state, "d-none")).toBeNull();
  });

  it("records the seq that wrote the response measure (add, then a resolve that supplies one)", () => {
    const state = fold(
      addedEvent("d-a", { class: "latency", response_measure: MEASURE }),
      addedEvent("d-b", { class: "latency" }),
      addedEvent("d-c"),
      resolvedEvent("d-a"),
      resolvedEvent("d-b", { response_measure: MEASURE }),
      resolvedEvent("d-c"),
    );
    expect(state.anomalies).toEqual([]);
    expect(state.decisions.map((record) => [record.id, record.measure_seq])).toEqual([
      ["d-a", 1],
      ["d-b", 5],
      ["d-c", null],
    ]);
  });

  it("keeps the interface body of a resolved interface decision", () => {
    const state = fold(
      addedEvent("d-interface", { class: "interface" }),
      resolvedEvent("d-interface", { interface: CONTRACT }),
    );
    expect(state.anomalies).toEqual([]);
    expect(state.decisions[0]).toMatchObject({ id: "d-interface", status: "resolved", interface: CONTRACT });
  });

  it("folds a human deferral and a human n/a", () => {
    const state = fold(addedEvent("d-a"), addedEvent("d-b"), deferredEvent("d-a"), naEvent("d-b"));
    expect(state.anomalies).toEqual([]);
    expect(findDecision(state, "d-a")).toMatchObject({
      status: "deferred",
      closed_seq: 3,
      deferral: {
        owner: "dev@example.com",
        reason: "needs production traffic numbers",
        revisit_trigger: "after the first week in production",
        default: "no cache",
        signed_by: HUMAN,
        expires_at: DEFERRAL_EXPIRES,
      },
    });
    expect(findDecision(state, "d-b")).toMatchObject({
      status: "na",
      closed_seq: 4,
      na: { rationale: "This item has no such concern.", by: HUMAN, at: DECISION_AT },
    });
  });

  it("counts only events of the folded goal and work item", () => {
    const otherGoal = { goal_id: "g-other", work_id: SCOPE.work_id };
    const events = eventsOf(
      addedEvent("d-cache", { scope: OTHER_SCOPE }),
      resolvedEvent("d-cache", { scope: OTHER_SCOPE }),
      addedEvent("d-cache", { scope: otherGoal }),
      resolvedEvent("d-cache", { scope: otherGoal }),
      NOISE,
      addedEvent("d-cache"),
    );
    const state = foldDecisions(events, SCOPE);
    expect(state.anomalies).toEqual([]);
    expect(state.decisions.map((record) => [record.id, record.status, record.added_seq])).toEqual([["d-cache", "open", 6]]);
    expect(foldDecisions(events, OTHER_SCOPE).decisions[0]?.status).toBe("resolved");
  });

  it("does not let omf or an agent close a decision", () => {
    const attempts = [
      addedEvent("d-a"),
      addedEvent("d-b"),
      addedEvent("d-c"),
      resolvedEvent("d-a", { actor: "omf" }),
      resolvedEvent("d-a", { actor: "agent:worker" }),
      deferredEvent("d-b", { actor: "agent:worker" }),
      naEvent("d-c", { actor: "omf" }),
    ];
    const state = fold(...attempts);
    expect(state.decisions.map((record) => [record.id, record.status, record.closed_seq])).toEqual([
      ["d-a", "open", null],
      ["d-b", "open", null],
      ["d-c", "open", null],
    ]);
    expect(state.anomalies).toEqual([
      { code: "resolution_not_human", decision_id: "d-a", seq: 4 },
      { code: "resolution_not_human", decision_id: "d-a", seq: 5 },
      { code: "deferral_unsigned", decision_id: "d-b", seq: 6 },
      { code: "na_not_human", decision_id: "d-c", seq: 7 },
    ]);

    // The first valid closing event wins; the forged attempts stay on record as anomalies.
    const later = fold(...attempts, resolvedEvent("d-a"));
    expect(findDecision(later, "d-a")).toMatchObject({ status: "resolved", closed_seq: 8 });
    expect(later.anomalies).toHaveLength(4);
  });

  it("does not accept a signature that differs from the event actor", () => {
    const stranger = "human:someone-else@example.com";
    const state = fold(
      addedEvent("d-a"),
      addedEvent("d-b"),
      addedEvent("d-c"),
      resolvedEvent("d-a", { by: stranger }),
      deferredEvent("d-b", { signed_by: stranger }),
      naEvent("d-c", { by: stranger }),
    );
    expect(state.decisions.map((record) => record.status)).toEqual(["open", "open", "open"]);
    expect(state.anomalies).toEqual([
      { code: "resolution_not_human", decision_id: "d-a", seq: 4 },
      { code: "deferral_unsigned", decision_id: "d-b", seq: 5 },
      { code: "na_not_human", decision_id: "d-c", seq: 6 },
    ]);
  });

  it("lets a person close a deferred decision again; resolved and n/a stay final (A21)", () => {
    const state = fold(
      addedEvent("d-a"), // 1
      addedEvent("d-b"), // 2
      addedEvent("d-c"), // 3
      addedEvent("d-d"), // 4
      deferredEvent("d-a"), // 5
      deferredEvent("d-b"), // 6
      deferredEvent("d-c"), // 7
      deferredEvent("d-d"), // 8
      resolvedEvent("d-a"), // 9: resolves the deferral
      deferredEvent("d-b", { default: "cache nothing" }), // 10: a new deferral replaces the old one
      naEvent("d-c"), // 11
      resolvedEvent("d-d"), // 12
      naEvent("d-d"), // 13: resolved is final
    );
    expect(state.anomalies).toEqual([{ code: "already_closed", decision_id: "d-d", seq: 13 }]);
    expect(findDecision(state, "d-a")).toMatchObject({ status: "resolved", closed_seq: 9, deferral: null });
    expect(findDecision(state, "d-b")).toMatchObject({ status: "deferred", closed_seq: 10, deferral: { default: "cache nothing" } });
    expect(findDecision(state, "d-c")).toMatchObject({ status: "na", closed_seq: 11, deferral: null });
    expect(findDecision(state, "d-d")).toMatchObject({ status: "resolved", closed_seq: 12 });
  });

  it("reports structural anomalies and keeps the first valid state", () => {
    const state = fold(
      addedEvent("d-a"), // 1
      addedEvent("d-a", { question: "Again?" }), // 2: duplicate
      resolvedEvent("d-nope"), // 3: unknown id
      resolvedEvent("d-a"), // 4: closes
      resolvedEvent("d-a", { choice: "something else" }), // 5: already closed
      rawDecisionEvent("decision.added", { decision_id: "d-bad", class: "other" }), // 6: no question
      rawDecisionEvent("decision.reopened", { decision_id: "d-a" }), // 7: no such event type
      addedEvent("d-wrong", { class: "interface" }), // 8: interface class under another id
      addedEvent("d-interface"), // 9: the interface id with another class
      addedEvent("d-q"), // 10
      resolvedEvent("d-q", { interface: CONTRACT }), // 11: interface body on a non-interface class
    );
    expect(state.anomalies).toEqual([
      { code: "duplicate_add", decision_id: "d-a", seq: 2 },
      { code: "unknown_decision", decision_id: "d-nope", seq: 3 },
      { code: "already_closed", decision_id: "d-a", seq: 5 },
      { code: "malformed_event", decision_id: "d-bad", seq: 6 },
      { code: "malformed_event", decision_id: "d-a", seq: 7 },
      { code: "interface_misplaced", decision_id: "d-wrong", seq: 8 },
      { code: "interface_misplaced", decision_id: "d-interface", seq: 9 },
      { code: "interface_misplaced", decision_id: "d-q", seq: 11 },
    ]);
    expect(state.decisions.map((record) => [record.id, record.status])).toEqual([
      ["d-a", "resolved"],
      ["d-q", "open"],
    ]);
    expect(findDecision(state, "d-a")?.resolution?.choice).toBe("memoize per input");
  });

  it("ignores decision.rejected", () => {
    const without = fold(addedEvent("d-a"), addedEvent("d-b"));
    const withAudit = fold(
      addedEvent("d-a"),
      addedEvent("d-b"),
      rejectedEvent("d-a"),
      rejectedEvent(null, { op: "resolve" }),
    );
    expect(withAudit.anomalies).toEqual([]);
    expect(withAudit.decisions).toEqual(without.decisions);
  });

  it("orders by add sequence and returns state detached from the events", () => {
    const events = eventsOf(
      addedEvent("d-b"),
      addedEvent("d-a"),
      resolvedEvent("d-b", { rejected: ["no cache"] }),
      addedEvent("d-c"),
    );
    const first = foldDecisions(events, SCOPE);
    expect(first.decisions.map((record) => [record.id, record.added_seq])).toEqual([
      ["d-b", 1],
      ["d-a", 2],
      ["d-c", 4],
    ]);
    expect(foldDecisions(events, SCOPE)).toEqual(first);

    // Editing the returned state must not reach back into the ledger events it was folded from.
    first.decisions[0]?.resolution?.rejected.push("tampered");
    expect(foldDecisions(events, SCOPE).decisions[0]?.resolution?.rejected).toEqual(["no cache"]);
  });
});

describe("decisionsDigest", () => {
  function scenario(
    change: { choice?: string; deferDefault?: string; closeB?: "defer" | "na"; threshold?: number } = {},
  ): NewEvent[] {
    return [
      addedEvent("d-a", {
        class: "latency",
        response_measure: { ...MEASURE, threshold: change.threshold ?? MEASURE.threshold },
      }),
      resolvedEvent("d-a", { choice: change.choice ?? "memoize per input" }),
      addedEvent("d-b"),
      change.closeB === "na" ? naEvent("d-b") : deferredEvent("d-b", { default: change.deferDefault ?? "no cache" }),
    ];
  }
  const digestOf = (...events: NewEvent[]): string => decisionsDigest(fold(...events));

  it("is stable and ignores seqs, signers and times", () => {
    const base = digestOf(...scenario());
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(digestOf(...scenario())).toBe(base);

    const other = "human:other@example.com";
    const variant = digestOf(
      NOISE,
      addedEvent("d-a", { class: "latency", response_measure: MEASURE, actor: "agent:worker" }),
      resolvedEvent("d-a", { actor: other, at: "2026-11-01T00:00:00.000Z" }),
      addedEvent("d-b", { actor: "agent:worker" }),
      deferredEvent("d-b", { actor: other }),
    );
    expect(variant).toBe(base);
  });

  it("changes when the content of a closed decision changes", () => {
    const digests = new Set([
      digestOf(...scenario()),
      digestOf(...scenario({ choice: "memoize per path" })),
      digestOf(...scenario({ deferDefault: "cache nothing" })),
      digestOf(...scenario({ closeB: "na" })),
      digestOf(...scenario({ threshold: 300 })),
    ]);
    expect(digests.size).toBe(5);
  });

  it("does not cover open decisions", () => {
    expect(digestOf(...scenario(), addedEvent("d-open"))).toBe(digestOf(...scenario()));
    expect(digestOf(addedEvent("d-open"))).toBe(decisionsDigest(foldDecisions([], SCOPE)));
  });
});
