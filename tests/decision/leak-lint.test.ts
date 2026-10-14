import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { leakContextAt, leakContextFor, lintDecisionStrings, loadLeakContext } from "../../src/decision/leak-lint.js";
import type { LeakContext } from "../../src/decision/leak-lint.js";
import { goalTemplate, parseGoal } from "../../src/goal/goal-file.js";
import type { GoalSemantic } from "../../src/goal/goal-file.js";
import { goalLockFile, lockGoal } from "../../src/goal/goal-lock.js";
import { CANARY } from "../helpers/canary.js";
import { setupGoal } from "../helpers/goal.js";

/** A locked semantic whose target metric and value are the given ones; everything else is the template's. */
function semanticFor(metricId: string, value: number): GoalSemantic {
  const front = parseGoal(goalTemplate("g-a")).front;
  return { ...front, target: { ...front.target, metric_id: metricId, value }, leading: [], lagging: [metricId], guardrails: [] };
}

/** The canary metric id with a chosen locked target value and chosen readings. */
function ctxFor(value: number, measured: readonly number[] = []): LeakContext {
  return leakContextFor(semanticFor(CANARY.metricId, value), measured);
}

const rulesOf = (body: unknown, ctx: LeakContext): string[] => [
  ...new Set(lintDecisionStrings(body, ctx).map((finding) => finding.rule)),
].sort();

const codeOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (err) {
    return (err as { code?: unknown }).code;
  }
  return undefined;
};

describe("leak lint, rule metric-name", () => {
  const ctx = ctxFor(Number(CANARY.target));

  it.each([
    ["id", { id: "d-zebra-quokka-cap" }],
    ["question", { question: "How should zebra quokka be capped?" }],
    ["qas.stimulus", { qas: { stimulus: "A zebra-quokka spike arrives" } }],
    ["response_measure.metric", { response_measure: { metric: CANARY.metricId } }],
    ["resolution.rejected[0]", { resolution: { rejected: ["Track ZebraQuokka per worker"] } }],
    ["interface.build[1]", { interface: { build: ["make", "zebra_quokka"] } }],
    ["interface.io_contract", { interface: { io_contract: "prints the zebra quokka report" } }],
  ])("finds a full metric phrase in %s", (field, body) => {
    expect(lintDecisionStrings(body, ctx)).toEqual([{ rule: "metric-name", field }]);
  });

  it("reports the rule and the field, never the matched text", () => {
    const findings = lintDecisionStrings({ question: `zebra quokka at ${CANARY.target}` }, ctx);
    expect(findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(findings)).not.toMatch(/zebra|quokka|3719/);
  });
});

describe("leak lint, rules target-value and number-value", () => {
  it("finds the locked target as a word-bounded literal", () => {
    const ctx = ctxFor(12);
    expect(rulesOf({ question: "Cap it at 12 workers" }, ctx)).toEqual(["number-value", "target-value"]);
    expect(rulesOf({ question: "Cap it at 127 workers" }, ctx)).toEqual([]);
    expect(rulesOf({ question: "Cap it at 1212 workers" }, ctx)).toEqual([]);
    expect(rulesOf({ question: "Release v12 is out" }, ctx)).toEqual([]);
    expect(rulesOf({ question: "Cap it at 12.5 workers" }, ctx)).toEqual([]);
  });

  it("compares a threshold and prose numbers as numbers", () => {
    const ctx = ctxFor(12);
    expect(lintDecisionStrings({ response_measure: { threshold: 12 } }, ctx)).toEqual([
      { rule: "number-value", field: "response_measure.threshold" },
    ]);
    expect(lintDecisionStrings({ response_measure: { threshold: 13 } }, ctx)).toEqual([]);
    // 12.0 is not the literal "12", so only the numeric rule can see it.
    expect(lintDecisionStrings({ question: "Is 12.0 seconds too slow?" }, ctx)).toEqual([{ rule: "number-value", field: "question" }]);
    // a unit glued to the digits is still a value
    expect(rulesOf({ question: "Is 12ms too slow?" }, ctx)).toEqual(["number-value", "target-value"]);
    expect(lintDecisionStrings({ question: "Allow 1,200 requests" }, ctxFor(1200))).toEqual([
      { rule: "number-value", field: "question" },
    ]);
  });

  it("refuses the integer part of a non-integer target, in prose and as a threshold", () => {
    const ctx = ctxFor(Number(CANARY.target));
    expect(lintDecisionStrings({ question: "about 3719 per second" }, ctx)).toEqual([{ rule: "number-value", field: "question" }]);
    expect(lintDecisionStrings({ response_measure: { threshold: 3719 } }, ctx)).toEqual([
      { rule: "number-value", field: "response_measure.threshold" },
    ]);
    expect(lintDecisionStrings({ response_measure: { threshold: 250 } }, ctx)).toEqual([]);
  });

  it("does not refuse an integer part of 0", () => {
    const ctx = ctxFor(0.25);
    expect(lintDecisionStrings({ question: "no more than 0 failures" }, ctx)).toEqual([]);
    expect(lintDecisionStrings({ response_measure: { threshold: 0 } }, ctx)).toEqual([]);
    expect(lintDecisionStrings({ response_measure: { threshold: 0.25 } }, ctx)).toEqual([
      { rule: "number-value", field: "response_measure.threshold" },
    ]);
  });

  it("refuses a value equal to a measured reading", () => {
    const ctx = ctxFor(250, [Number(CANARY.reading)]);
    expect(lintDecisionStrings({ response_measure: { threshold: 4817.39 } }, ctx)).toEqual([
      { rule: "number-value", field: "response_measure.threshold" },
    ]);
    expect(lintDecisionStrings({ question: "it reads 4817 today" }, ctx)).toEqual([{ rule: "number-value", field: "question" }]);
    expect(lintDecisionStrings({ response_measure: { threshold: 4900 } }, ctx)).toEqual([]);
  });

  it("exempts percentile and the keys OMF sets", () => {
    expect(lintDecisionStrings({ response_measure: { percentile: 95, threshold: 250 } }, ctxFor(95))).toEqual([]);
    const set = { class: "latency", op: "<=", by: "human:12", signed_by: "human:12", at: "12", expires_at: "12", kind: "cli" };
    expect(lintDecisionStrings(set, ctxFor(12))).toEqual([]);
  });
});

describe("leak lint, clean text and pinned limits", () => {
  const ctx = ctxFor(Number(CANARY.target), [Number(CANARY.reading)]);

  it("passes a clean decision that carries a numeric threshold", () => {
    const body = {
      id: "d-cache-scope",
      class: "latency",
      question: "Should the cache be shared by all workers?",
      qas: { source: "a visitor", stimulus: "opens a page", environment: "normal load", artifact: "the cache", response: "serves it" },
      response_measure: { metric: "queue depth", op: "<=", threshold: 250, unit: "items", percentile: 95, window: "5 minutes" },
    };
    expect(lintDecisionStrings(body, ctx)).toEqual([]);
  });

  // A18: these pass by design. Forbidding every stem would make ordinary decision text unwritable, and a
  // deterministic lint cannot see paraphrase. The W test and the README row claim only what is covered above.
  it("does not detect near values, paraphrases, single stems or watched-path stems", () => {
    expect(lintDecisionStrings({ response_measure: { threshold: 3700 } }, ctx)).toEqual([]);
    expect(lintDecisionStrings({ question: "About 3,700 per second" }, ctx)).toEqual([]);
    expect(lintDecisionStrings({ question: "Roughly a dozen workers" }, ctxFor(12))).toEqual([]);
    expect(lintDecisionStrings({ question: "Is the quokka cache warm?" }, ctx)).toEqual([]);
    expect(lintDecisionStrings({ interface: { run: ["sh", CANARY.watchedPath] } }, ctx)).toEqual([]);
  });
});

describe("leak context", () => {
  it("is built from the locked semantic and the readings", () => {
    const ctx = leakContextFor(semanticFor(CANARY.metricId, Number(CANARY.target)));
    expect(ctx.targetValues).toEqual(["3719.25"]);
    expect(ctx.targetNumbers).toEqual([3719.25]);
    expect(ctx.measuredNumbers).toEqual([]);
    expect(ctx.terms.phrases).toContain("zebra quokka");
  });

  it("is loaded from the goal lock and every measured reading of the goal", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    const measured = (goalId: string, value: unknown): void => {
      fx.ledger.append({ actor: "omf", type: "metric.measured", payload: { goal_id: goalId, metric_id: "m-p95", value } });
    };
    measured("g-fast", 312);
    measured("g-fast", 312);
    measured("g-fast", 0.4);
    measured("g-other", 999);
    measured("g-fast", "n/a");
    const ctx = loadLeakContext(fx.location.dir, "g-fast", fx.ledger.readVerified());
    expect(ctx.targetValues).toEqual(["250"]);
    expect(ctx.targetNumbers).toEqual([250]);
    expect(ctx.measuredNumbers).toEqual([0.4, 312]);
    expect(ctx.terms.phrases).toContain("p95");
  });

  it("limits the readings to those recorded up to a ledger seq (A22)", () => {
    const fx = setupGoal();
    lockGoal(fx.location, "g-fast", "human:dev");
    for (const value of [312, 0.4, 500]) {
      fx.ledger.append({ actor: "omf", type: "metric.measured", payload: { goal_id: "g-fast", metric_id: "m-p95", value } });
    }
    const ctx = loadLeakContext(fx.location.dir, "g-fast", fx.ledger.readVerified());
    const seqs = (ctx.readings ?? []).map((reading) => reading.seq);
    expect(seqs).toHaveLength(3);
    expect(leakContextAt(ctx, 0).measuredNumbers).toEqual([]);
    expect(leakContextAt(ctx, seqs[0] ?? 0).measuredNumbers).toEqual([312]);
    expect(leakContextAt(ctx, seqs[1] ?? 0).measuredNumbers).toEqual([0.4, 312]);
    expect(leakContextAt(ctx, Number.MAX_SAFE_INTEGER).measuredNumbers).toEqual(ctx.measuredNumbers);
    expect(leakContextAt(ctx, 0).targetNumbers).toEqual(ctx.targetNumbers);
    // A context without per-reading seqs is returned as it is.
    const plain = leakContextFor(semanticFor(CANARY.metricId, Number(CANARY.target)), [4817.39]);
    expect(leakContextAt(plain, 0)).toBe(plain);
  });

  it("fails closed without a usable goal lock", () => {
    const fx = setupGoal();
    expect(codeOf(() => loadLeakContext(fx.location.dir, "g-fast", []))).toBe("goal_not_locked");
    const file = goalLockFile(fx.location.dir, "g-fast");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{");
    expect(codeOf(() => loadLeakContext(fx.location.dir, "g-fast", []))).toBe("goal_not_locked");
  });
});
