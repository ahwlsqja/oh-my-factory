import { describe, expect, it } from "vitest";
import type { DecisionClass } from "../../src/decision/types.js";
import { decideRelease, meetsMargin, scorePct, type LadderBest } from "../../src/feedback/ladder.js";
import { FeedbackError, type CategoryTally } from "../../src/feedback/types.js";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof FeedbackError ? err.code : "not a FeedbackError";
  }
  return undefined;
}

function tally(category: DecisionClass, pass: number, total: number): CategoryTally {
  return { category, pass, total, flaky: 0 };
}

function bestOf(entries: [DecisionClass, number, number][]): LadderBest {
  return new Map(entries.map(([category, pass, n]) => [category, { pass, n }]));
}

describe("scorePct", () => {
  it("floors to a whole percent and is exact at multiples", () => {
    expect(scorePct(2, 3)).toBe(66);
    expect(scorePct(1, 3)).toBe(33);
    expect(scorePct(19, 20)).toBe(95);
    expect(scorePct(0, 5)).toBe(0);
    expect(scorePct(5, 5)).toBe(100);
    expect(scorePct(29, 100)).toBe(29);
  });

  it("refuses impossible counts", () => {
    expect(codeOf(() => scorePct(1, 0))).toBe("invalid_input");
    expect(codeOf(() => scorePct(6, 5))).toBe("invalid_input");
    expect(codeOf(() => scorePct(-1, 5))).toBe("invalid_input");
    expect(codeOf(() => scorePct(1.5, 5))).toBe("invalid_input");
  });
});

describe("meetsMargin", () => {
  it("follows 10*d >= n && d*d >= n at the boundaries", () => {
    // [n, d, expected]; d is the gain in passed scenarios over the best released one.
    const table: [number, number, boolean][] = [
      [5, 2, false],
      [5, 3, true],
      [9, 2, false],
      [9, 3, true],
      [25, 4, false],
      [25, 5, true],
      [100, 9, false],
      [100, 10, true],
      [101, 10, false],
      [101, 11, true],
      // The floored-percent trap (M3d-D4): 10 of 110 is 9.09%, below the 10% floor, even though floor percents differ by 10.
      [110, 10, false],
      [110, 11, true],
      [20, 1, false],
      [20, 4, false],
      [20, 5, true],
    ];
    for (const [n, d, expected] of table) expect(meetsMargin(d, n), `n=${n} d=${d}`).toBe(expected);
  });

  it("never accepts a gain of zero or less, and refuses impossible counts", () => {
    expect(meetsMargin(0, 5)).toBe(false);
    expect(meetsMargin(-3, 5)).toBe(false);
    expect(codeOf(() => meetsMargin(1, 0))).toBe("invalid_input");
    expect(codeOf(() => meetsMargin(1.5, 10))).toBe("invalid_input");
    expect(codeOf(() => meetsMargin(1, 10.5))).toBe("invalid_input");
  });
});

describe("decideRelease", () => {
  it("releases the actual score as first when there is no best", () => {
    const out = decideRelease(new Map(), [tally("interface", 7, 10)]);
    expect(out).toEqual([{ category: "interface", n: 10, pass: 7, score_pct: 70, kind: "first" }]);
  });

  it("releases new at exactly the margin and repeats the best one pass below it", () => {
    const best = bestOf([["security", 10, 25]]);
    expect(decideRelease(best, [tally("security", 15, 25)])).toEqual([
      { category: "security", n: 25, pass: 15, score_pct: 60, kind: "new" },
    ]);
    expect(decideRelease(best, [tally("security", 14, 25)])).toEqual([
      { category: "security", n: 25, pass: 10, score_pct: 40, kind: "repeat" },
    ]);
  });

  it("never shows a decrease and does not move on a one-scenario gain over 20", () => {
    expect(decideRelease(bestOf([["other", 15, 25]]), [tally("other", 8, 25)])).toEqual([
      { category: "other", n: 25, pass: 15, score_pct: 60, kind: "repeat" },
    ]);
    // 100% against a best of 95% with n=20 is a gain of one scenario: below the margin, so the 95 repeats.
    expect(decideRelease(bestOf([["other", 19, 20]]), [tally("other", 20, 20)])).toEqual([
      { category: "other", n: 20, pass: 19, score_pct: 95, kind: "repeat" },
    ]);
  });

  it("decides each category on its own and keeps the input order", () => {
    const best = bestOf([["security", 10, 25]]);
    const out = decideRelease(best, [tally("security", 15, 25), tally("interface", 5, 5)]);
    expect(out.map((c) => [c.category, c.kind])).toEqual([
      ["security", "new"],
      ["interface", "first"],
    ]);
  });

  it("refuses a best that was measured over a different number of scenarios", () => {
    expect(codeOf(() => decideRelease(bestOf([["other", 5, 10]]), [tally("other", 9, 12)]))).toBe("invalid_input");
  });
});
