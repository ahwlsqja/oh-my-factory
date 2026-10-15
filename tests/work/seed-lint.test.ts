import { describe, expect, it } from "vitest";
import { parseGoal, goalTemplate } from "../../src/goal/goal-file.js";
import { forbiddenTermsFor, lintCandidate, lintText } from "../../src/work/seed-lint.js";
import type { ForbiddenTerms } from "../../src/work/seed-lint.js";
import type { IntentCandidate } from "../../src/work/types.js";

/** A locked semantic that references exactly these metric ids (target first). */
function termsFor(target: string, rest: { leading?: string[]; guardrails?: string[] } = {}): ForbiddenTerms {
  const front = parseGoal(goalTemplate("g-a")).front;
  return forbiddenTermsFor({
    ...front,
    target: { ...front.target, metric_id: target },
    leading: rest.leading ?? [],
    lagging: [target],
    guardrails: rest.guardrails ?? [],
  });
}

const NO_TERMS: ForbiddenTerms = { phrases: [] };
const rules = (text: string, terms: ForbiddenTerms = NO_TERMS): string[] =>
  lintText("problem", text, terms).map((finding) => finding.rule);

describe("seed lint, rule number", () => {
  it.each([
    "reduce latency by 20%",
    "under 250 ms",
    "p95 of 312",
    "3.5",
    "1,200 users",
    "within 5 minutes",
    "at most 4",
    "twenty percent",
    "100",
    "make it 2x faster",
    "keep it below 3",
    "latency <250",
    "five hundred ms",
    "twenty-five percent",
    "version 1.2.3",
    "2026-10-12",
  ])("rejects %j", (text) => {
    expect(rules(text)).toEqual(["number"]);
  });

  it.each([
    "step 2",
    "use utf8",
    "sha256",
    "v2 API",
    "add 3 retries",
    "1. first item",
    "intro\n2) second item\n10. tenth item",
    "Bring back the old checkout flow",
    "Use two retries before giving up",
  ])("accepts %j", (text) => {
    expect(rules(text)).toEqual([]);
  });

  it("does not read a unit across a line break", () => {
    expect(rules("step 2\nx marks the spot")).toEqual([]);
  });

  it("reports a field once per rule, however many numbers it holds", () => {
    expect(lintText("problem", "20% and 30% and 40 ms", NO_TERMS)).toEqual([{ rule: "number", field: "problem" }]);
  });
});

describe("seed lint, rule metric-name", () => {
  const errorRate = termsFor("m-error-rate");

  it.each([
    "error rate",
    "error-rate",
    "error_rate",
    "errorRate",
    "m-error-rate",
    "ERROR_RATE",
    "The Error Rate drops",
  ])("rejects %j for m-error-rate", (text) => {
    expect(rules(text, errorRate)).toEqual(["metric-name"]);
  });

  it("accepts a single ordinary word of a multi-word id", () => {
    expect(rules("reduce errors on checkout", errorRate)).toEqual([]);
    expect(rules("lower the rate of retries", errorRate)).toEqual([]);
  });

  it("rejects a stem that holds a digit, and accepts the other words of the id", () => {
    const p95 = termsFor("m-p95-latency");
    expect(rules("improve p95 on search", p95)).toEqual(["metric-name"]);
    expect(rules("improve P95Latency on search", p95)).toEqual(["metric-name"]);
    expect(rules("improve latency on search", p95)).toEqual([]);
  });

  it("rejects the only stem of a one-word id", () => {
    const latency = termsFor("m-latency");
    expect(rules("improve latency", latency)).toEqual(["metric-name"]);
  });

  it("matches on word boundaries", () => {
    const error = termsFor("m-error");
    expect(rules("the terrorist example", error)).toEqual([]);
    expect(rules("remove the error", error)).toEqual(["metric-name"]);
  });

  it("covers every metric the goal references, not only the target", () => {
    const terms = termsFor("m-p95", { leading: ["m-cache-hits"], guardrails: ["m-error-budget"] });
    expect(rules("raise cache hits", terms)).toEqual(["metric-name"]);
    expect(rules("protect the error budget", terms)).toEqual(["metric-name"]);
  });

  it("builds sorted, normalized phrases", () => {
    expect(termsFor("m-error-rate").phrases).toEqual(["error rate", "m error rate"]);
    expect(termsFor("m-p95-latency").phrases).toEqual(["m p95 latency", "p95", "p95 latency"]);
    expect(termsFor("m-latency").phrases).toEqual(["latency", "m latency"]);
  });
});

describe("seed lint findings", () => {
  it("never carry the matched text", () => {
    const terms = termsFor("m-error-rate");
    const findings = lintText("problem", "cut the error rate by 20% to 250 ms", terms);
    expect(findings).toEqual([
      { rule: "number", field: "problem" },
      { rule: "metric-name", field: "problem" },
    ]);
    const json = JSON.stringify(findings);
    for (const leaked of ["20", "250", "error", "rate"]) expect(json).not.toContain(leaked);
  });
});

const candidate: IntentCandidate = {
  title: "Cache the search index",
  problem: "Search rebuilds its index on every request.",
  proposed_outcome: "Search keeps a warm index between requests.",
  affected_users_systems: "Anyone who searches.",
  constraints: "",
  open_questions: ["Which cache does the team already run?"],
  rationale: "Rebuilding is the slow part.",
  affected_paths: ["src/search", "docs/v2/a.md"],
};

describe("lintCandidate", () => {
  it("accepts a clean candidate", () => {
    expect(lintCandidate(candidate, termsFor("m-p95"))).toEqual([]);
  });

  it("names the field of every finding", () => {
    const dirty = {
      ...candidate,
      title: "Cut it by 20%",
      rationale: "Because p95 is high",
      open_questions: ["fine", "Is 250 ms enough?"],
    };
    expect(lintCandidate(dirty, termsFor("m-p95"))).toEqual([
      { rule: "number", field: "title" },
      { rule: "metric-name", field: "rationale" },
      { rule: "number", field: "open_questions[1]" },
    ]);
  });

  it("lints declared paths for forbidden names and for decimals or long digit runs", () => {
    const terms = termsFor("m-p95");
    const bad = (path: string): string[] =>
      lintCandidate({ ...candidate, affected_paths: [path] }, terms).map(
        (finding) => `${finding.rule}:${finding.field}`,
      );
    expect(bad("bench/m-p95.sh")).toEqual(["metric-name:affected_paths[0]"]);
    expect(bad("lib/python3.12/x")).toEqual(["number:affected_paths[0]"]);
    expect(bad("db/migrations/20260101_add.sql")).toEqual(["number:affected_paths[0]"]);
    expect(bad("docs/v2/a.md")).toEqual([]);
    expect(bad("src/h264/codec.ts")).toEqual([]);
  });
});
