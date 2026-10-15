import { rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validate } from "../../src/core/schema.js";
import { claimFile } from "../../src/work/claim.js";
import {
  type BudgetAnomalyCode,
  type OwnedAppend,
  REENTRY_KILLS_MAX,
  REENTRY_SAME_REASON_MAX,
  WORK_BUDGET_EVENT_TYPES,
  WorkBudgetError,
  foldReentry,
  foldWorkBudget,
  microUsd,
  raiseWorkLimit,
  recordLimits,
  recordRound,
  recordSpend,
} from "../../src/work/w-budget.js";
import { CANARY } from "../helpers/canary.js";
import { W_RUN, type WFixture, setupW } from "../helpers/w-verbs-fixture.js";
import { appendWorkEvent, recordW } from "../helpers/work.js";

const SCOPE = { goal_id: "g-fast", work_id: "w-0123456789ab", run_id: "r-20261012T100000Z-ab12" };
const SIG = "a".repeat(64);

/** One valid payload per event type. */
const GOOD: Record<string, Record<string, unknown>> = {
  "work.limits_set": { ...SCOPE, max_rounds: 3, max_model_micro_usd: 5_000_000 },
  "work.limit_raised": { goal_id: SCOPE.goal_id, work_id: SCOPE.work_id, kind: "rounds", amount: 2 },
  "work.round": { ...SCOPE, round: 1, prev_signature: null },
  "work.spend": { ...SCOPE, station: "S3", micro_usd: 1200 },
};

const accepts = (type: string, payload: unknown): boolean =>
  validate("work-budget-event.schema.json", { type, payload }).ok;

// M3b2-D1, D2: every payload is ids, integers, a station id or a digest. No free text, so no metric can enter.
describe("work budget event schema", () => {
  it("accepts one valid payload per type, and the table covers every type", () => {
    expect(Object.keys(GOOD).sort()).toEqual([...WORK_BUDGET_EVENT_TYPES].sort());
    for (const [type, payload] of Object.entries(GOOD)) expect(accepts(type, payload), type).toBe(true);
  });

  it("accepts a null previous signature, a real one and an unknown (null) spend", () => {
    expect(accepts("work.round", { ...SCOPE, round: 2, prev_signature: SIG })).toBe(true);
    expect(accepts("work.spend", { ...SCOPE, station: "S7", micro_usd: null })).toBe(true);
    expect(accepts("work.spend", { ...SCOPE, station: "S1", micro_usd: 0 })).toBe(true);
  });

  it.each(Object.keys(GOOD))("%s rejects an extra field", (type) => {
    expect(accepts(type, { ...GOOD[type], note: "free text" })).toBe(false);
  });

  it.each<[string, string, Record<string, unknown>]>([
    ["a malformed run id", "work.round", { run_id: "r-1" }],
    ["a run id on a raise (a person has no run)", "work.limit_raised", { run_id: SCOPE.run_id }],
    ["a malformed work id", "work.spend", { work_id: "w-xyz" }],
    ["zero rounds", "work.limits_set", { max_rounds: 0 }],
    ["more than 100 rounds", "work.limits_set", { max_rounds: 101 }],
    ["a fractional round limit", "work.limits_set", { max_rounds: 2.5 }],
    ["a zero spend limit", "work.limits_set", { max_model_micro_usd: 0 }],
    ["a limit above the safe integers", "work.limits_set", { max_model_micro_usd: 2 ** 53 }],
    ["a zero raise", "work.limit_raised", { amount: 0 }],
    ["a negative raise", "work.limit_raised", { amount: -1 }],
    ["a fractional raise", "work.limit_raised", { amount: 1.5 }],
    ["an unknown limit kind", "work.limit_raised", { kind: "tokens" }],
    ["round zero", "work.round", { round: 0 }],
    ["a signature that is not 64 hex digits", "work.round", { prev_signature: "a".repeat(63) }],
    ["an uppercase signature", "work.round", { prev_signature: "A".repeat(64) }],
    ["a station that does not exist", "work.spend", { station: "S8" }],
    ["a negative spend", "work.spend", { micro_usd: -1 }],
    ["a fractional spend", "work.spend", { micro_usd: 1.5 }],
  ])("rejects %s", (_label, type, patch) => {
    expect(accepts(type, { ...GOOD[type], ...patch })).toBe(false);
  });

  it("rejects a type that is not one of the four", () => {
    expect(accepts("work.budget", GOOD["work.spend"])).toBe(false);
  });
});

// M3b2-D2: spend is whole micro-dollars so sums never drift; the config keeps dollars and converts once.
describe("microUsd", () => {
  it("converts dollars to whole micro-dollars, stable for floating point sums", () => {
    expect(microUsd(5)).toBe(5_000_000);
    expect(microUsd(0.1 + 0.2)).toBe(300_000);
    expect(microUsd(0.000001)).toBe(1);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e-9, 1e12])("refuses %s", (usd) => {
    expect(() => microUsd(usd)).toThrow(RangeError);
  });
});

const LIMITS = { max_rounds: 3, max_model_micro_usd: 5_000_000 };

/** Appends a ledger event as any actor, valid or not, and returns its seq. The fold must judge it, not the writer. */
function put(fx: WFixture, actor: string, type: string, payload: Record<string, unknown>): number {
  return fx.ledger.append({ actor, type, payload }).seq;
}
const limits = (fx: WFixture, extra: Record<string, unknown> = {}) => ({ ...fx.scope, ...LIMITS, ...extra });
const roundOf = (fx: WFixture, round: number, sig: string | null = null) => ({
  ...fx.scope,
  round,
  prev_signature: sig,
});
const spendOf = (fx: WFixture, micro: number | null, station = "S3") => ({ ...fx.scope, station, micro_usd: micro });
const raiseOf = (fx: WFixture, kind: string, amount: number) => ({
  goal_id: fx.goalId,
  work_id: fx.workId,
  kind,
  amount,
});
const fold = (fx: WFixture) => foldWorkBudget(fx.events(), fx.workId);

const EMPTY = {
  limits: null,
  raised: { rounds: 0, model_micro_usd: 0 },
  effective: null,
  rounds_started: 0,
  previous_signature: null,
  spend: { micro_usd: 0, unknown_count: 0 },
  anomalies: [],
};

// M3b2-D1 to D3: the counts come from the ledger alone, and anything the fold cannot trust is an anomaly
// that GATE-4 (Task 3) turns into a closed failure.
describe("foldWorkBudget", () => {
  it("is empty for a ledger with no budget events", () => {
    expect(fold(setupW())).toEqual(EMPTY);
  });

  it("folds limits, a person's raises, rounds and spend, and effective is limits plus raises", () => {
    const fx = setupW();
    const sig2 = "b".repeat(64);
    put(fx, "omf", "work.limits_set", limits(fx));
    put(fx, "human:dev", "work.limit_raised", raiseOf(fx, "rounds", 2));
    put(fx, "human:dev", "work.limit_raised", raiseOf(fx, "model_micro_usd", 1_000_000));
    put(fx, "omf", "work.round", roundOf(fx, 1));
    put(fx, "omf", "work.spend", spendOf(fx, 1000));
    put(fx, "omf", "work.spend", spendOf(fx, null, "S4"));
    put(fx, "omf", "work.round", roundOf(fx, 2, sig2));
    put(fx, "omf", "work.spend", spendOf(fx, 500, "S5"));
    expect(fold(fx)).toEqual({
      limits: LIMITS,
      raised: { rounds: 2, model_micro_usd: 1_000_000 },
      effective: { max_rounds: 5, max_model_micro_usd: 6_000_000 },
      rounds_started: 2,
      previous_signature: sig2,
      spend: { micro_usd: 1500, unknown_count: 1 },
      anomalies: [],
    });
  });

  it("skips another item's events, valid or not", () => {
    const fx = setupW();
    const other = { goal_id: fx.goalId, work_id: "w-aaaaaaaaaaaa", run_id: W_RUN };
    put(fx, "omf", "work.limits_set", { ...other, ...LIMITS });
    put(fx, "omf", "work.spend", { ...other, station: "S3", micro_usd: -5 });
    put(fx, "human:dev", "work.limit_raised", {
      goal_id: fx.goalId,
      work_id: "w-aaaaaaaaaaaa",
      kind: "rounds",
      amount: 1,
    });
    expect(fold(fx)).toEqual(EMPTY);
  });

  const ANOMALIES: [string, BudgetAnomalyCode, (fx: WFixture) => number][] = [
    ["a spend written by a person", "not_omf", (fx) => put(fx, "human:dev", "work.spend", spendOf(fx, 5))],
    ["a round written by an agent", "not_omf", (fx) => put(fx, "agent:x", "work.round", roundOf(fx, 1))],
    ["a limits event written by a person", "not_omf", (fx) => put(fx, "human:dev", "work.limits_set", limits(fx))],
    [
      "a raise written by omf",
      "not_human",
      (fx) => {
        put(fx, "omf", "work.limits_set", limits(fx));
        return put(fx, "omf", "work.limit_raised", raiseOf(fx, "rounds", 1));
      },
    ],
    [
      "a second limits event",
      "limits_twice",
      (fx) => {
        put(fx, "omf", "work.limits_set", limits(fx));
        return put(fx, "omf", "work.limits_set", limits(fx, { max_rounds: 50 }));
      },
    ],
    [
      "a raise before any limits",
      "raise_before_limits",
      (fx) => put(fx, "human:dev", "work.limit_raised", raiseOf(fx, "rounds", 1)),
    ],
    ["a round that skips a number", "round_gap", (fx) => put(fx, "omf", "work.round", roundOf(fx, 2))],
    ["a spend with a negative amount", "invalid_event", (fx) => put(fx, "omf", "work.spend", spendOf(fx, -1))],
    [
      "a limits event with a planted stray field",
      "invalid_event",
      (fx) => put(fx, "omf", "work.limits_set", limits(fx, { note: CANARY.metricId })),
    ],
  ];

  it.each(ANOMALIES)("%s is one anomaly and counts for nothing", (_label, code, build) => {
    const fx = setupW();
    const seq = build(fx);
    const state = fold(fx);
    expect(state.anomalies).toEqual([{ code, seq }]);
    expect(state.rounds_started).toBe(0);
    expect(state.spend).toEqual({ micro_usd: 0, unknown_count: 0 });
    expect(state.raised).toEqual({ rounds: 0, model_micro_usd: 0 });
    // The anomaly carries a code and a seq, never the rejected payload.
    expect(JSON.stringify(state)).not.toContain(CANARY.metricId);
  });

  it("keeps the first limits when a second one is forged", () => {
    const fx = setupW();
    put(fx, "omf", "work.limits_set", limits(fx));
    put(fx, "omf", "work.limits_set", limits(fx, { max_rounds: 50 }));
    expect(fold(fx).effective).toEqual(LIMITS);
  });

  it("saturates instead of overflowing, so a huge spend still exhausts the limit", () => {
    const fx = setupW();
    put(fx, "omf", "work.spend", spendOf(fx, Number.MAX_SAFE_INTEGER));
    put(fx, "omf", "work.spend", spendOf(fx, 10));
    expect(fold(fx).spend.micro_usd).toBe(Number.MAX_SAFE_INTEGER);
  });

  // Depends row 7: the M3b1 verifier and `verifiedItems` must not be confused by the four new types.
  it("leaves the M3b1 verifier and verifiedItems unaffected by all four event types", () => {
    const fx = setupW();
    put(fx, "omf", "work.limits_set", limits(fx));
    put(fx, "human:dev", "work.limit_raised", raiseOf(fx, "rounds", 1));
    put(fx, "omf", "work.round", roundOf(fx, 1));
    put(fx, "omf", "work.spend", spendOf(fx, 1));
    expect(fx.verdict()).toEqual({ ok: true });
    expect(fx.verified().items.map((item) => item.front.work_id)).toEqual([fx.workId]);
    expect(fx.verified().malformed).toEqual([]);
  });
});

const own = (fx: WFixture): OwnedAppend => ({
  ledger: fx.ledger,
  itemDir: fx.item.dir,
  claim: fx.claim,
  scope: fx.scope,
});

function budgetCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof WorkBudgetError ? err.code : "other error";
  }
  return "no error";
}

// M3b2-D3: a round is consumed before the work, under the claim, so a kill cannot dodge the count.
describe("owned appends", () => {
  it("recordLimits writes one omf event, and a second call writes nothing and returns null", () => {
    const fx = setupW();
    const event = recordLimits(own(fx), LIMITS);
    expect(event).toMatchObject({ actor: "omf", type: "work.limits_set", payload: { ...fx.scope, ...LIMITS } });
    const before = fx.ledgerText();
    expect(recordLimits(own(fx), { max_rounds: 9, max_model_micro_usd: 9 })).toBeNull();
    expect(fx.ledgerText()).toBe(before);
    expect(fold(fx).effective).toEqual(LIMITS);
  });

  it("recordRound numbers rounds from the ledger and carries the previous signature", () => {
    const fx = setupW();
    expect(recordRound(own(fx), null).payload).toMatchObject({ ...fx.scope, round: 1, prev_signature: null });
    expect(recordRound(own(fx), SIG).payload).toMatchObject({ round: 2, prev_signature: SIG });
    expect(fold(fx)).toMatchObject({ rounds_started: 2, previous_signature: SIG, anomalies: [] });
  });

  it("recordSpend records a known and an unknown spend per station", () => {
    const fx = setupW();
    recordSpend(own(fx), "S3", 1200);
    recordSpend(own(fx), "S4", null);
    expect(fold(fx).spend).toEqual({ micro_usd: 1200, unknown_count: 1 });
  });

  it("refuses an invalid spend and writes nothing", () => {
    const fx = setupW();
    const before = fx.ledgerText();
    expect(() => recordSpend(own(fx), "S3", -1)).toThrow("invalid work.spend event");
    expect(() => recordSpend(own(fx), "S3", 1.5)).toThrow("invalid work.spend event");
    expect(fx.ledgerText()).toBe(before);
  });

  const BREAKS: [string, (fx: WFixture) => void][] = [
    ["the claim file is gone", (fx) => rmSync(claimFile(fx.item.dir))],
    [
      "another process owns the claim",
      (fx) =>
        writeFileSync(
          claimFile(fx.item.dir),
          JSON.stringify({ pid: process.pid + 1, start_time: fx.claim.start_time, acquired_at: fx.claim.acquired_at }),
        ),
    ],
    [
      "the claim was re-acquired later by the same pid",
      (fx) =>
        writeFileSync(
          claimFile(fx.item.dir),
          JSON.stringify({
            pid: fx.claim.pid,
            start_time: fx.claim.start_time,
            acquired_at: "2030-01-01T00:00:00.000Z",
          }),
        ),
    ],
  ];

  it.each(BREAKS)("every append refuses with claim_lost and writes nothing when %s", (_label, breakClaim) => {
    const fx = setupW();
    breakClaim(fx);
    const before = fx.ledgerText();
    expect(budgetCode(() => recordLimits(own(fx), LIMITS))).toBe("claim_lost");
    expect(budgetCode(() => recordRound(own(fx), null))).toBe("claim_lost");
    expect(budgetCode(() => recordSpend(own(fx), "S3", 1))).toBe("claim_lost");
    expect(fx.ledgerText()).toBe(before);
  });
});

const OTHER_ITEM = { front: { goal_id: "g-fast", work_id: "w-aaaaaaaaaaaa" } };
const reentry = (fx: WFixture) => foldReentry(fx.events(), fx.goalId, fx.workId);

// Spec §4.4: the same blocker three times escalates to J6. The count is read from the ledger, so a restart
// cannot reset it, and only a person's act on the goal does (M3b2-D17).
describe("foldReentry", () => {
  it("has limits of three, for both counts", () => {
    expect([REENTRY_SAME_REASON_MAX, REENTRY_KILLS_MAX]).toEqual([3, 3]);
  });

  it("is zero for a ledger with no parks and no reclaims", () => {
    expect(reentry(setupW())).toEqual({ same_reason: 0, kills: 0 });
  });

  it("counts the largest number of parks with one reason, and every reclaim", () => {
    const fx = setupW();
    for (const reason_code of ["j2_open", "j2_open", "gate_blocked", "j2_open"]) {
      recordW(fx.ledger, "work.parked", fx.item, { reason_code });
    }
    recordW(fx.ledger, "work.claim_reclaimed", fx.item);
    recordW(fx.ledger, "work.claim_reclaimed", fx.item);
    expect(reentry(fx)).toEqual({ same_reason: 3, kills: 2 });
  });

  it("does not count reentry_loop or budget_exhausted parks, which are the guard's own stops", () => {
    const fx = setupW();
    for (const reason_code of ["reentry_loop", "budget_exhausted", "reentry_loop", "budget_exhausted"]) {
      recordW(fx.ledger, "work.parked", fx.item, { reason_code });
    }
    expect(reentry(fx)).toEqual({ same_reason: 0, kills: 0 });
  });

  it("ignores another item's events and a park nobody trusted (an agent wrote it)", () => {
    const fx = setupW();
    recordW(fx.ledger, "work.parked", OTHER_ITEM);
    recordW(fx.ledger, "work.claim_reclaimed", OTHER_ITEM);
    fx.ledger.append({
      actor: "agent:x",
      type: "work.parked",
      payload: { ...fx.scope, outcome: "blocked", reason_code: "j2_open" },
    });
    expect(reentry(fx)).toEqual({ same_reason: 0, kills: 0 });
  });

  it("starts again after a person's act on this goal, and not after one on another goal", () => {
    const fx = setupW();
    for (let n = 0; n < 3; n++) recordW(fx.ledger, "work.parked", fx.item);
    recordW(fx.ledger, "work.claim_reclaimed", fx.item);
    fx.ledger.append({
      actor: "human:dev",
      type: "work.approved",
      payload: { goal_id: "g-other", work_id: "w-bbbbbbbbbbbb" },
    });
    expect(reentry(fx)).toEqual({ same_reason: 3, kills: 1 });
    appendWorkEvent(fx.ledger, "work.approved", "human:dev", fx.item);
    expect(reentry(fx)).toEqual({ same_reason: 0, kills: 0 });
    recordW(fx.ledger, "work.parked", fx.item);
    expect(reentry(fx)).toEqual({ same_reason: 1, kills: 0 });
  });
});

function raiseCode(
  fx: WFixture,
  actor: string,
  kind: "rounds" | "model_micro_usd",
  amount: number,
  workId = fx.workId,
): string {
  return budgetCode(() => raiseWorkLimit(fx.ctx.location, workId, kind, amount, actor));
}

/** An item the ledger and the file agree is `in_progress`. */
function startItem(fx: WFixture): void {
  fx.appendOnly({ type: "work.started", payload: { ...fx.scope, from: "ready" } });
  fx.handEdit("in_progress");
}

// J8 (spec §4.4): a person raises one limit of an open item. The raise is a ledger event; nothing else can lift a limit.
describe("raiseWorkLimit", () => {
  it("refuses an actor that is not a person, and writes nothing", () => {
    const fx = setupW();
    recordLimits(own(fx), LIMITS);
    const before = fx.ledgerText();
    for (const actor of ["omf", "agent:x", "human:", "dev"])
      expect(raiseCode(fx, actor, "rounds", 1), actor).toBe("forbidden");
    expect(fx.ledgerText()).toBe(before);
  });

  it("refuses an amount that is not a positive whole number", () => {
    const fx = setupW();
    recordLimits(own(fx), LIMITS);
    for (const amount of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
      expect(raiseCode(fx, "human:dev", "model_micro_usd", amount), String(amount)).toBe("invalid_amount");
    }
  });

  it("appends one human work.limit_raised for a ready item, even while a run holds the claim", () => {
    const fx = setupW();
    recordLimits(own(fx), LIMITS);
    const event = raiseWorkLimit(fx.ctx.location, fx.workId, "rounds", 2, "human:dev");
    expect(event).toMatchObject({
      actor: "human:dev",
      type: "work.limit_raised",
      payload: { goal_id: fx.goalId, work_id: fx.workId, kind: "rounds", amount: 2 },
    });
    raiseWorkLimit(fx.ctx.location, fx.workId, "model_micro_usd", 250_000, "human:dev");
    expect(fold(fx)).toMatchObject({
      raised: { rounds: 2, model_micro_usd: 250_000 },
      effective: { max_rounds: 5, max_model_micro_usd: 5_250_000 },
      anomalies: [],
    });
    expect(fx.verdict()).toEqual({ ok: true });
  });

  it("works for an in_progress item", () => {
    const fx = setupW();
    recordLimits(own(fx), LIMITS);
    startItem(fx);
    expect(raiseCode(fx, "human:dev", "rounds", 1)).toBe("no error");
  });

  it("refuses an item that is not open, has no limits, is malformed or unknown, and writes nothing", () => {
    const fx = setupW();
    expect(raiseCode(fx, "human:dev", "rounds", 1), "no limits yet").toBe("no_limits");

    recordLimits(own(fx), LIMITS);
    expect(raiseCode(fx, "human:dev", "rounds", 1, "w-ffffffffffff"), "unknown item").toBe("malformed");
    expect(raiseCode(fx, "human:dev", "rounds", 1, "not-a-work-id"), "ill-formed id").toBe("malformed");

    fx.handEdit("in_progress"); // a hand edit: no work.started event behind it
    expect(raiseCode(fx, "human:dev", "rounds", 1), "hand-edited state").toBe("malformed");
    fx.handEdit("ready");

    startItem(fx);
    fx.appendOnly({
      type: "work.submitted",
      payload: { ...fx.scope, outcome: "flawed", recommendation: "not_recommended" },
    });
    fx.handEdit("awaiting_review");
    const before = fx.ledgerText();
    expect(raiseCode(fx, "human:dev", "rounds", 1), "awaiting_review").toBe("wrong_state");
    expect(fx.ledgerText()).toBe(before);
  });

  it("puts only ids and codes in an error, never the id it was given", () => {
    const fx = setupW();
    expect(() => raiseWorkLimit(fx.ctx.location, CANARY.metricId, "rounds", 1, "human:dev")).toThrow(WorkBudgetError);
    try {
      raiseWorkLimit(fx.ctx.location, CANARY.metricId, "rounds", 1, "human:dev");
    } catch (err) {
      expect((err as Error).message).not.toContain(CANARY.metricId);
    }
  });
});
