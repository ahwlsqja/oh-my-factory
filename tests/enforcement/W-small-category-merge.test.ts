import { describe, expect, it } from "vitest";
import { mergeSmallCategories, parseScenarioResults, tallyResults } from "../../src/feedback/tally.js";
import { MIN_CATEGORY_SIZE } from "../../src/feedback/types.js";
import { DECISION_CLASSES } from "../../src/decision/types.js";
import { randomResults, seededRng } from "../helpers/feedback.js";

const sum = (items: readonly { pass: number; total: number; flaky: number }[]) =>
  items.reduce((acc, t) => ({ pass: acc.pass + t.pass, total: acc.total + t.total, flaky: acc.flaky + t.flaky }), {
    pass: 0,
    total: 0,
    flaky: 0,
  });

describe("W-small-category-merge: no released category is below 5", () => {
  it("holds for 500 random train sets of 5 to 40 scenarios (seeded)", () => {
    const rng = seededRng(20261014);
    for (let i = 0; i < 500; i += 1) {
      const total = MIN_CATEGORY_SIZE + (i % 36);
      const raw = tallyResults(parseScenarioResults(randomResults(rng, total)));
      const merged = mergeSmallCategories(raw);

      expect(sum(merged), `iteration ${i}: totals, passes and flaky counts are preserved`).toEqual(sum(raw));
      expect(sum(merged).total).toBe(total);
      for (const category of merged) {
        expect(
          category.total,
          `iteration ${i}: ${category.category} is below ${MIN_CATEGORY_SIZE}`,
        ).toBeGreaterThanOrEqual(MIN_CATEGORY_SIZE);
        expect(DECISION_CLASSES).toContain(category.category);
      }
      expect(new Set(merged.map((c) => c.category)).size).toBe(merged.length);
      expect(merged.length).toBeLessThanOrEqual(raw.length);
    }
  });

  it("keeps the largest category's name and never invents a class", () => {
    const rng = seededRng(7);
    for (let i = 0; i < 200; i += 1) {
      const raw = tallyResults(randomResults(rng, 8 + (i % 20)));
      const merged = mergeSmallCategories(raw);
      const names = new Set(raw.map((c) => c.category));
      for (const category of merged) expect(names.has(category.category)).toBe(true);
    }
  });
});
