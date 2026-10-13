import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REFRESH } from "../../src/core/config.js";
import { evaluateStaleness } from "../../src/goal/refresh.js";
import type { GoalApproval } from "../../src/goal/goal-lock.js";

const DAY = 86_400_000;
const APPROVED_AT = "2026-10-01T00:00:00.000Z";
const approval: GoalApproval = {
  regime: 1,
  semantic_sha256: "a".repeat(64),
  head_commit: "b".repeat(40),
  metrics: ["m-p95"],
  approved_by: "human:dev@example.com",
  approved_at: APPROVED_AT,
  first_approved_at: APPROVED_AT,
  bands_sha256: null,
  wall_time: null,
};

type Args = Parameters<typeof evaluateStaleness>[0];

/** One day after approval, no new commits, target unmet and unchanged: nothing is tripped. */
function args(overrides: Partial<Args> = {}): Args {
  return {
    approval,
    config: REFRESH,
    now: new Date(Date.parse(APPROVED_AT) + DAY),
    commitsSince: 0,
    targetFirst: 312,
    targetLatest: 312,
    targetOperator: "<=",
    targetMet: false,
    ...overrides,
  };
}

function at(ms: number): Date {
  return new Date(Date.parse(APPROVED_AT) + ms);
}

describe("evaluateStaleness: age and commits", () => {
  it("is not stale inside every limit", () => {
    expect(evaluateStaleness(args())).toEqual({
      stale: false,
      tripped: [],
      signals: { age_ms: DAY, commits_since: 0, target_move: 0 },
    });
  });

  it("trips age only past max_age (exactly 14 days is not stale)", () => {
    expect(evaluateStaleness(args({ now: at(14 * DAY) })).tripped).toEqual([]);
    const verdict = evaluateStaleness(args({ now: at(14 * DAY + 1) }));
    expect(verdict.stale).toBe(true);
    expect(verdict.tripped).toEqual(["age"]);
    expect(verdict.signals.age_ms).toBe(14 * DAY + 1);
  });

  it("trips commits only past max_commits (exactly 50 is not stale)", () => {
    expect(evaluateStaleness(args({ commitsSince: 50 })).tripped).toEqual([]);
    const verdict = evaluateStaleness(args({ commitsSince: 51 }));
    expect(verdict.tripped).toEqual(["commits"]);
    expect(verdict.signals.commits_since).toBe(51);
  });

  it("treats a vanished approval commit as tripped commits", () => {
    const verdict = evaluateStaleness(args({ commitsSince: null }));
    expect(verdict.stale).toBe(true);
    expect(verdict.tripped).toEqual(["commits"]);
    expect(verdict.signals.commits_since).toBeNull();
  });

  it("lists every tripped signal in a fixed order", () => {
    const verdict = evaluateStaleness(
      args({ now: at(30 * DAY), commitsSince: 400, targetLatest: 1000 }),
    );
    expect(verdict.tripped).toEqual(["age", "commits", "target_move"]);
  });
});

describe("evaluateStaleness: target_move counts only worsening", () => {
  it("is not stale when a <= metric improves but still misses the target", () => {
    const verdict = evaluateStaleness(args({ targetFirst: 10, targetLatest: 8 }));
    expect(verdict.signals.target_move).toBe(0);
    expect(verdict.tripped).toEqual([]);
  });

  it("is stale when a <= metric worsens past the limit", () => {
    const verdict = evaluateStaleness(args({ targetFirst: 10, targetLatest: 40 }));
    expect(verdict.signals.target_move).toBe(3);
    expect(verdict.tripped).toEqual(["target_move"]);
  });

  it("compares the relative move exclusively (exactly 1.0 is not stale)", () => {
    expect(evaluateStaleness(args({ targetFirst: 10, targetLatest: 20 })).tripped).toEqual([]);
    expect(evaluateStaleness(args({ targetFirst: 10, targetLatest: 21 })).tripped).toEqual(["target_move"]);
  });

  it("is not stale when a >= metric improves a lot (success-like movement)", () => {
    const verdict = evaluateStaleness(
      args({ targetOperator: ">=", targetFirst: 10, targetLatest: 80, targetMet: false }),
    );
    expect(verdict.signals.target_move).toBe(0);
    expect(verdict.tripped).toEqual([]);
  });

  it("is stale when a >= metric falls below zero", () => {
    const verdict = evaluateStaleness(
      args({ targetOperator: ">=", targetFirst: 10, targetLatest: -5, targetMet: false }),
    );
    expect(verdict.signals.target_move).toBe(1.5);
    expect(verdict.tripped).toEqual(["target_move"]);
  });

  it("documents that a >= metric falling to 10% of its first value is not stale", () => {
    const verdict = evaluateStaleness(
      args({ targetOperator: ">=", targetFirst: 10, targetLatest: 1, targetMet: false }),
    );
    expect(verdict.signals.target_move).toBeCloseTo(0.9, 10);
    expect(verdict.tripped).toEqual([]);
  });

  it("is null and not tripped while the latest measurement meets the target", () => {
    const verdict = evaluateStaleness(args({ targetFirst: 10, targetLatest: 40, targetMet: true }));
    expect(verdict.signals.target_move).toBeNull();
    expect(verdict.tripped).toEqual([]);
  });

  it("uses the absolute delta when the first value is zero", () => {
    const small = evaluateStaleness(args({ targetFirst: 0, targetLatest: 1 }));
    expect(small.signals.target_move).toBe(1);
    expect(small.tripped).toEqual([]);
    const large = evaluateStaleness(args({ targetFirst: 0, targetLatest: 2 }));
    expect(large.signals.target_move).toBe(2);
    expect(large.tripped).toEqual(["target_move"]);
    const down = evaluateStaleness(args({ targetOperator: ">=", targetFirst: 0, targetLatest: -3 }));
    expect(down.signals.target_move).toBe(3);
    expect(down.tripped).toEqual(["target_move"]);
  });

  it("counts any movement for an == target that is not met", () => {
    expect(evaluateStaleness(args({ targetOperator: "==", targetFirst: 10, targetLatest: 12 })).signals.target_move).toBeCloseTo(0.2, 10);
    expect(evaluateStaleness(args({ targetOperator: "==", targetFirst: 10, targetLatest: 30 })).tripped).toEqual(["target_move"]);
  });

  it("is null and not tripped when a value or the verdict is missing", () => {
    const cases: Partial<Args>[] = [
      { targetFirst: null, targetLatest: 1000 },
      { targetFirst: 10, targetLatest: null },
      { targetFirst: 10, targetLatest: 1000, targetMet: null },
    ];
    for (const overrides of cases) {
      const verdict = evaluateStaleness(args(overrides));
      expect(verdict.signals.target_move).toBeNull();
      expect(verdict.tripped).toEqual([]);
    }
  });
});

describe("refresh.ts", () => {
  it("never reads the clock", () => {
    const source = readFileSync(new URL("../../src/goal/refresh.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/Date\.now\(|new Date\(\s*\)/);
  });
});
