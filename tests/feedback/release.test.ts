import { describe, expect, it } from "vitest";
import { exposureUnitsOf, ladderStateFromEvents } from "../../src/feedback/events.js";
import { type ImplementerFeedback, type ReleaseInput, releaseFeedback } from "../../src/feedback/release.js";
import { isAllowlistedFeedback, renderFeedback } from "../../src/feedback/render.js";
import { FeedbackError, type ReleasedCategory, type ScenarioResult } from "../../src/feedback/types.js";
import { DIGEST, GOAL, WORK, counts, declaredLedger, eventsOf, releaseInput, remaining } from "../helpers/release-fixture.js";

/** The FeedbackError code a call throws, "not a FeedbackError" for anything else, undefined when it does not throw. */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof FeedbackError ? err.code : "not a FeedbackError";
  }
  return undefined;
}

describe("releaseFeedback: validation comes first", () => {
  it("refuses an undeclared disclosure budget and writes nothing", () => {
    const ledger = declaredLedger(null);
    expect(codeOf(() => releaseFeedback(ledger, releaseInput(counts({ interface: [3, 5] }))))).toBe("not_declared");
    expect(ledger.readVerified()).toHaveLength(0);
  });

  it("an empty train split is an error, never a pass", () => {
    const ledger = declaredLedger(3);
    expect(codeOf(() => releaseFeedback(ledger, releaseInput([])))).toBe("no_train_scenarios");
  });

  it("withholds a train split under five scenarios without touching the ledger, and releases five", () => {
    const ledger = declaredLedger(3);
    for (const total of [1, 2, 4]) {
      expect(releaseFeedback(ledger, releaseInput(counts({ interface: [1, total] })))).toEqual({
        status: "withheld",
        reason: "too_few_scenarios",
      });
    }
    expect(ledger.readVerified()).toHaveLength(1);
    expect(remaining(ledger)).toBe(3);
    expect(releaseFeedback(ledger, releaseInput(counts({ interface: [1, 5] }))).status).toBe("released");
  });

  it("a malformed id, limit or result throws invalid_input before anything is spent, even with no budget declared", () => {
    const ledger = declaredLedger(3);
    const bad: Partial<ReleaseInput>[] = [
      { goalId: "G-Checkout" },
      { workId: "w-123" },
      { runId: "run-1" },
      { trainDigest: "abc" },
      { exposureLimit: Number.NaN },
      { exposureLimit: 0 },
      { exposureLimit: 21 },
      { exposureLimit: 1.5 },
      { exposureLimit: "5" as unknown as number },
      { results: [{ category: "interface", passed: true, flaky: false, scenario_id: "s-1" }] as unknown as ScenarioResult[] },
    ];
    for (const extra of bad) {
      expect(codeOf(() => releaseFeedback(ledger, releaseInput(counts({ interface: [3, 5] }), extra)))).toBe("invalid_input");
    }
    expect(ledger.readVerified()).toHaveLength(1);
    expect(remaining(ledger)).toBe(3);
    const undeclared = declaredLedger(null);
    expect(codeOf(() => releaseFeedback(undeclared, releaseInput(counts({ interface: [3, 5] }), { exposureLimit: 0 })))).toBe(
      "invalid_input",
    );
  });
});

describe("releaseFeedback: the Ladder and the disclosure unit", () => {
  it("the first release shows every score, spends exactly one unit and writes the unit and the release side by side", () => {
    const ledger = declaredLedger(3);
    const result = releaseFeedback(ledger, releaseInput(counts({ interface: [3, 5], security: [4, 5] })));
    if (result.status !== "released") throw new Error(`expected a release, got ${result.reason}`);
    expect(result.host_only).toMatchObject({ round: 1, disclosure_units: 1 });
    expect(result.host_only.categories.map((c) => [c.category, c.kind, c.score_pct])).toEqual([
      ["interface", "first", 60],
      ["security", "first", 80],
    ]);
    const events = ledger.readVerified();
    expect(events.slice(1).map((e) => e.type)).toEqual(["budget.consumed", "feedback.released"]);
    expect(events[2]?.seq).toBe((events[1]?.seq ?? 0) + 1);
    expect(events[1]?.payload).toEqual({ goal_id: GOAL, kind: "disclosure", amount: 1 });
    expect(remaining(ledger)).toBe(2);
  });

  it("hands out the rendered, allowlisted text and nothing else", () => {
    const ledger = declaredLedger(3);
    const result = releaseFeedback(ledger, releaseInput(counts({ interface: [3, 5], security: [4, 5] })));
    if (result.status !== "released") throw new Error("expected a release");
    const stored = eventsOf(ledger, "feedback.released")[0]?.payload.categories as ReleasedCategory[];
    expect(result.feedback.text).toBe(renderFeedback(stored));
    expect(isAllowlistedFeedback(result.feedback.text)).toBe(true);
    expect(Object.keys(result.feedback)).toEqual(["text"]);
  });

  it("repeats an identical or lower round for free and never shows a decrease", () => {
    const ledger = declaredLedger(3);
    releaseFeedback(ledger, releaseInput(counts({ interface: [3, 5], security: [4, 5] })));
    const before = ledger.readVerified().length;
    const again = releaseFeedback(ledger, releaseInput(counts({ interface: [3, 5], security: [4, 5] })));
    const lower = releaseFeedback(ledger, releaseInput(counts({ interface: [0, 5], security: [4, 5] })));
    if (again.status !== "released" || lower.status !== "released") throw new Error("expected releases");
    expect(again.host_only).toMatchObject({ round: 2, disclosure_units: 0 });
    expect(lower.host_only.categories.map((c) => [c.kind, c.pass, c.score_pct])).toEqual([
      ["repeat", 3, 60],
      ["repeat", 4, 80],
    ]);
    expect(ledger.readVerified().slice(before).map((e) => e.type)).toEqual(["feedback.released", "feedback.released"]);
    expect(remaining(ledger)).toBe(2);
  });

  it("decides the margin on pass counts: 11 of 110 after 1 repeats, 12 releases (the floored-percent trap)", () => {
    const ledger = declaredLedger(5);
    releaseFeedback(ledger, releaseInput(counts({ interface: [1, 110] })));
    const trap = releaseFeedback(ledger, releaseInput(counts({ interface: [11, 110] })));
    if (trap.status !== "released") throw new Error("expected a release");
    expect(trap.host_only.categories[0]).toMatchObject({ kind: "repeat", pass: 1, score_pct: 0 });
    expect(remaining(ledger)).toBe(4);
    const gain = releaseFeedback(ledger, releaseInput(counts({ interface: [12, 110] })));
    if (gain.status !== "released") throw new Error("expected a release");
    expect(gain.host_only.categories[0]).toMatchObject({ kind: "new", pass: 12, score_pct: 10 });
    expect(remaining(ledger)).toBe(3);
  });

  it("withholds a due new score when the pool is empty, writes nothing, and still repeats", () => {
    const ledger = declaredLedger(1);
    releaseFeedback(ledger, releaseInput(counts({ interface: [0, 5], security: [0, 5] })));
    expect(remaining(ledger)).toBe(0);
    const before = ledger.readVerified().length;
    expect(releaseFeedback(ledger, releaseInput(counts({ interface: [3, 5], security: [0, 5] })))).toEqual({
      status: "withheld",
      reason: "disclosure_exhausted",
    });
    expect(ledger.readVerified()).toHaveLength(before);
    expect(releaseFeedback(ledger, releaseInput(counts({ interface: [0, 5], security: [0, 5] }))).status).toBe("released");
  });

  it("stops new scores at the exposure limit of the work item and still repeats", () => {
    const ledger = declaredLedger(10);
    const at = (pass: number) => releaseFeedback(ledger, releaseInput(counts({ interface: [pass, 10] }), { exposureLimit: 2 }));
    expect(at(0).status).toBe("released");
    expect(at(4).status).toBe("released");
    expect(exposureUnitsOf(ledger.readVerified(), GOAL, WORK)).toBe(2);
    expect(at(8)).toEqual({ status: "withheld", reason: "exposure_limit" });
    expect(remaining(ledger)).toBe(8);
    expect(at(4).status).toBe("released");
  });

  it("refuses a layout that differs from the one recorded for the digest, before any consumption", () => {
    const ledger = declaredLedger(5);
    releaseFeedback(ledger, releaseInput(counts({ interface: [3, 5], security: [4, 5] })));
    const before = ledger.readVerified().length;
    expect(codeOf(() => releaseFeedback(ledger, releaseInput(counts({ interface: [3, 6], security: [4, 5] }))))).toBe("invalid_input");
    expect(codeOf(() => releaseFeedback(ledger, releaseInput(counts({ interface: [3, 5], security: [4, 5] }), { workId: "w-aaaaaaaaaaaa" })))).toBe(
      "invalid_input",
    );
    expect(ledger.readVerified()).toHaveLength(before);
    expect(remaining(ledger)).toBe(4);
  });

  it("a different train digest of the same work item starts a fresh baseline but draws on the same pool and exposure count", () => {
    const ledger = declaredLedger(3);
    releaseFeedback(ledger, releaseInput(counts({ interface: [3, 5] })));
    const other = "b".repeat(64);
    const fresh = releaseFeedback(ledger, releaseInput(counts({ interface: [2, 6] }), { trainDigest: other }));
    if (fresh.status !== "released") throw new Error("expected a release");
    expect(fresh.host_only.categories[0]).toMatchObject({ kind: "first", pass: 2, n: 6 });
    const events = ledger.readVerified();
    expect(remaining(ledger)).toBe(1);
    expect(exposureUnitsOf(events, GOAL, WORK)).toBe(2);
    expect(ladderStateFromEvents(events, GOAL, DIGEST).best.get("interface")).toEqual({ pass: 3, n: 5 });
    expect(ladderStateFromEvents(events, GOAL, other).releases).toBe(1);
  });
});

describe("releaseFeedback: what the delivery path can accept", () => {
  it("takes the branded text only, not host_only, not the whole result, not a plain object", () => {
    const deliver = (feedback: ImplementerFeedback): string => feedback.text;
    const result = releaseFeedback(declaredLedger(3), releaseInput(counts({ interface: [3, 5] })));
    if (result.status !== "released") throw new Error("expected a release");
    expect(deliver(result.feedback)).toBe(result.feedback.text);
    // @ts-expect-error host_only (kind, round, units) must not be forwardable
    deliver(result.host_only);
    // @ts-expect-error the whole result must not be forwardable
    deliver(result);
    // @ts-expect-error only releaseFeedback can mint the brand
    deliver({ text: "Masked feedback" });
  });
});
