import { describe, expect, it } from "vitest";
import { DECISION_CLASSES } from "../../src/decision/types.js";
import { isAllowlistedFeedback, renderFeedback } from "../../src/feedback/render.js";
import { FeedbackError } from "../../src/feedback/types.js";
import type { ReleasedCategory } from "../../src/feedback/types.js";

/** A released line whose pass count is derived from the percent, so pass <= n holds. */
function cat(
  category: string,
  score_pct: number,
  n: number,
  kind: ReleasedCategory["kind"] = "first",
): ReleasedCategory {
  return { category, n, pass: Math.floor((score_pct * n) / 100), score_pct, kind } as unknown as ReleasedCategory;
}

const HEADER = "Masked feedback from the train scenarios.";
const FOOTER = "No other information about the scenarios is available.";

/** Seeded PRNG (mulberry32): the property loops are reproducible and need no dependency. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const codeOf = (fn: () => unknown): { code: unknown; message: string } | null => {
  try {
    fn();
  } catch (err) {
    return err instanceof FeedbackError
      ? { code: err.code, message: err.message }
      : { code: "not a FeedbackError", message: String(err) };
  }
  return null;
};

describe("renderFeedback", () => {
  it("renders the exact fixed template for a two-category release", () => {
    const text = renderFeedback([cat("interface", 66, 12), cat("security", 100, 5)]);
    expect(text).toBe(
      [HEADER, "- interface: 66% of 12 scenarios", "- security: 100% of 5 scenarios", FOOTER].join("\n"),
    );
  });

  it("orders the lines by DECISION_CLASSES whatever the input order", () => {
    const text = renderFeedback([cat("other", 10, 10), cat("compatibility", 20, 10), cat("interface", 30, 10)]);
    expect(text.split("\n").slice(1, -1)).toEqual([
      "- interface: 30% of 10 scenarios",
      "- compatibility: 20% of 10 scenarios",
      "- other: 10% of 10 scenarios",
    ]);
  });

  it("does not print the kind, the pass count or any round", () => {
    const text = renderFeedback([cat("interface", 40, 25, "new"), cat("other", 40, 25, "repeat")]);
    expect(text).not.toMatch(/first|new|repeat|round|pass/i);
    expect(text.match(/\d+/g)).toEqual(["40", "25", "40", "25"]);
  });

  it("refuses an empty list and a repeated category", () => {
    expect(codeOf(() => renderFeedback([]))?.code).toBe("invalid_input");
    expect(codeOf(() => renderFeedback([cat("other", 10, 10), cat("other", 20, 10)]))?.code).toBe("invalid_input");
  });

  it("refuses an unknown category, a bad percent and a bad n without echoing the value", () => {
    const bad: [string, ReleasedCategory][] = [
      ["unknown category", cat("CANARY-7731.4159", 50, 10)],
      ["capitalised category", cat("Interface", 50, 10)],
      ["negative percent", cat("other", -7731, 10)],
      ["percent over 100", cat("other", 101, 10)],
      ["fractional percent", cat("other", 7731.4159, 10)],
      ["NaN percent", cat("other", Number.NaN, 10)],
      ["zero n", cat("other", 50, 0)],
      ["fractional n", cat("other", 50, 7731.4159)],
      ["n over the cap", cat("other", 50, 10_000_000)],
    ];
    for (const [label, entry] of bad) {
      const result = codeOf(() => renderFeedback([entry]));
      expect(result?.code, label).toBe("invalid_input");
      expect(result?.message, label).not.toMatch(/7731|CANARY|Interface/);
    }
  });
});

describe("isAllowlistedFeedback", () => {
  const good = renderFeedback([cat("interface", 66, 12), cat("other", 0, 5)]);

  it("accepts rendered output", () => {
    expect(isAllowlistedFeedback(good)).toBe(true);
  });

  it("refuses one added line, a trailing id, a trailing newline and an empty text", () => {
    const lines = good.split("\n");
    expect(
      isAllowlistedFeedback([...lines.slice(0, -1), "- scenario-ab12: 0% of 1 scenarios", FOOTER].join("\n")),
    ).toBe(false);
    expect(isAllowlistedFeedback([...lines, "see s-7731"].join("\n"))).toBe(false);
    expect(isAllowlistedFeedback(`${good}\n`)).toBe(false);
    expect(isAllowlistedFeedback("")).toBe(false);
  });

  it("refuses one altered character class in any line", () => {
    const altered = [
      good.replace("- interface: 66%", "- Interface: 66%"),
      good.replace("66%", "66.5%"),
      good.replace("66%", "66 %"),
      good.replace("66%", "101%"),
      good.replace("of 12 scenarios", "of 12 scenarios!"),
      good.replace("of 12", "of 012"),
      good.replace("- interface:", "- invented:"),
      good.replace(HEADER, `${HEADER} `),
      good.replace(/\n/g, "\r\n"),
    ];
    for (const text of altered) expect(isAllowlistedFeedback(text), text).toBe(false);
  });

  it("refuses a text without the header, the footer or any category line", () => {
    expect(isAllowlistedFeedback([HEADER, FOOTER].join("\n"))).toBe(false);
    expect(isAllowlistedFeedback(good.split("\n").slice(1).join("\n"))).toBe(false);
    expect(isAllowlistedFeedback(good.split("\n").slice(0, -1).join("\n"))).toBe(false);
  });

  it("holds for 200 random releases: every line is fixed, digits are only percents and counts, nothing else leaks", () => {
    const next = prng(20261012);
    for (let i = 0; i < 200; i += 1) {
      const chosen = DECISION_CLASSES.filter(() => next() < 0.4);
      const picks =
        chosen.length > 0
          ? chosen
          : [DECISION_CLASSES[Math.floor(next() * DECISION_CLASSES.length)] as (typeof DECISION_CLASSES)[number]];
      const released: ReleasedCategory[] = picks.map((category) => {
        const n = 1 + Math.floor(next() * 200);
        const pass = Math.floor(next() * (n + 1));
        const kinds = ["first", "new", "repeat"] as const;
        return {
          category,
          n,
          pass,
          score_pct: Math.floor((100 * pass) / n),
          kind: kinds[Math.floor(next() * 3)] as ReleasedCategory["kind"],
        };
      });
      const text = renderFeedback(released);
      expect(isAllowlistedFeedback(text)).toBe(true);
      const lines = text.split("\n");
      expect(lines[0]).toBe(HEADER);
      expect(lines.at(-1)).toBe(FOOTER);
      expect(lines.slice(1, -1)).toHaveLength(released.length);
      const expectedDigits = released.flatMap((entry) => [String(entry.score_pct), String(entry.n)]);
      expect(lines.slice(1, -1).join("\n").match(/\d+/g)).toEqual(expectedDigits);
      expect(text).not.toMatch(/\b(first|new|repeat|round|pass|goal|work|run)\b/i);
    }
  });
});
