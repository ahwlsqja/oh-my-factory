import { describe, expect, it } from "vitest";
import { validate } from "../../src/core/schema.js";
import { WORK_BUDGET_EVENT_TYPES, microUsd } from "../../src/work/w-budget.js";

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
