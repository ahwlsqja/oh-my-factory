import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runDecideAdd, runDecideDefer, runDecideResolve } from "../../src/cli/decide.js";
import { needsHumanFile } from "../../src/decision/needs-human.js";
import { specFile } from "../../src/decision/spec-md.js";
import { findDecision } from "../../src/decision/state.js";
import { goalFile } from "../../src/goal/goal-file.js";
import { CANARY, canaryHits } from "../helpers/canary.js";
import { payloadText } from "../helpers/enforcement-goal.js";
import {
  CONTRACT,
  HUMAN,
  NOW,
  addOpen,
  closeInterface,
  decideCli,
  decisionEvents,
  errorCode,
  measureOnce,
  relockTarget,
  resolveOpen,
  reasonsOf,
  reportAt,
  setupDecisionItem,
  writeJson,
  type DecisionFixture,
} from "../helpers/decision-fixture.js";

// Spec §4.6 (F6), the W side of E2 for decision text: what a person writes into a decision is shown to the
// implementer and the verifier through spec.md, so it must not carry the metric, the locked target or a
// measured reading. Covered: a full metric phrase or id, the target value and its integer part, a number
// equal to a measured reading, a numeric response_measure.threshold equal to either, a planted id.
// NOT covered (documented limits of a deterministic lint): near values (3700 for 3719.25), paraphrases, a single
// stem of a multi-stem metric id, the stems of the watched path, and a lone single digit (0 to 9) equal to a reading
// or to the integer part of the target: a lone digit is refused only when it equals the locked target itself (A16a).
const PLANTS: Array<[string, string]> = [
  ["a full metric phrase", "Cache the zebra quokka results"],
  ["the metric id", `Tune ${CANARY.metricId} first`],
  ["the locked target value", `Stay under ${CANARY.target}`],
  ["the integer part of the target", "Stay under 3719 entries"],
  ["a thousands-separated integer part", "Stay under 3,719 entries"],
  ["a measured reading", `Last reading was ${CANARY.reading}`],
];

function leakFixture(): DecisionFixture {
  const f = setupDecisionItem();
  measureOnce(f); // so that the reading is a number the lint knows about
  closeInterface(f);
  addOpen(f, "d-cache");
  addOpen(f, "d-hold");
  return f;
}

describe("W-decision-no-metric-leak", () => {
  it("refuses every plant in add, resolve and defer, and every equal threshold; accepts a clean number", () => {
    const f = leakFixture();
    const loc = f.fx.location;
    for (const [index, [name, text]] of PLANTS.entries()) {
      const id = `d-plant-${index}`;
      expect(errorCode(() => runDecideAdd(loc, f.workId, { id, class: "other", question: `${text}?` }, "omf")), `add: ${name}`).toBe("leak");
      expect(
        errorCode(() => runDecideResolve(loc, f.workId, "d-cache", { choice: "Keep the current behavior", rationale: text, rejected: [] }, HUMAN)),
        `resolve: ${name}`,
      ).toBe("leak");
      expect(
        errorCode(() =>
          runDecideDefer(loc, f.workId, "d-hold", { owner: "dev", reason: "Later.", revisit_trigger: "After review.", default: text, expires_at: "2099-01-01T00:00:00.000Z" }, HUMAN, NOW),
        ),
        `defer: ${name}`,
      ).toBe("leak");
    }
    const events = decisionEvents(f);
    expect(events.filter((e) => e.type === "decision.rejected")).toHaveLength(PLANTS.length * 3);
    expect(events.filter((e) => e.type === "decision.added" && String(e.payload.decision_id).startsWith("d-plant"))).toEqual([]);
    expect(events.filter((e) => e.type === "decision.resolved" || e.type === "decision.deferred").length, "nothing was closed by a refused write").toBe(1);

    const measure = (threshold: number, id: string) =>
      runDecideAdd(
        loc,
        f.workId,
        { id, class: "latency", question: "How fast must a lookup be?", response_measure: { metric: "cache lookup time", op: "<=", threshold, unit: "ms", percentile: null, window: null } },
        "omf",
      );
    for (const threshold of [3719.25, 3719, 4817.39, 4817]) {
      expect(errorCode(() => measure(threshold, "d-latency-x")), `threshold ${threshold}`).toBe("leak");
    }
    // Positive control: the same shape with a number that is neither the target nor a reading is a normal decision.
    expect(errorCode(() => measure(40, "d-latency"))).toBe("no error");

    // A planted id is refused before any decision event, and the rejection keeps only a hash of the id.
    expect(errorCode(() => runDecideAdd(loc, f.workId, { id: "d-zebra-quokka", class: "other", question: "Is it needed?" }, "omf"))).toBe("leak");
    const after = decisionEvents(f);
    expect(after.some((e) => e.type === "decision.added" && e.payload.decision_id === "d-zebra-quokka")).toBe(false);
    const byId = after.filter((e) => e.type === "decision.rejected" && "decision_id_sha12" in e.payload);
    expect(byId).toHaveLength(1);
    expect(byId[0]?.payload).not.toHaveProperty("decision_id");
    expect(byId[0]?.payload).toMatchObject({ op: "add" });
  });

  it("refuses a plant in the QAS, in a measure's metric name and in an interface argv element", () => {
    const f = leakFixture();
    const loc = f.fx.location;
    const plant = "Cache the zebra quokka results";
    const rejections = () => decisionEvents(f).filter((e) => e.type === "decision.rejected");
    const before = rejections().length;

    // add: a QAS field and the metric name of a measure
    const qas = { source: "a caller", stimulus: "a lookup", environment: plant, artifact: "the cache", response: "an answer" };
    expect(errorCode(() => runDecideAdd(loc, f.workId, { id: "d-qas", class: "other", question: "Is it needed?", qas }, "omf")), "add: QAS").toBe("leak");
    const measure = { metric: plant, op: "<=" as const, threshold: 40, unit: "ms", percentile: null, window: null };
    expect(
      errorCode(() => runDecideAdd(loc, f.workId, { id: "d-metric", class: "latency", question: "How fast must a lookup be?", response_measure: measure }, "omf")),
      "add: measure metric",
    ).toBe("leak");

    // resolve: the measure again, and an interface argv element (the lint runs before the preconditions)
    expect(
      errorCode(() => runDecideResolve(loc, f.workId, "d-cache", { choice: "Keep it", rationale: "Nothing changes.", rejected: [], response_measure: measure }, HUMAN)),
      "resolve: measure metric",
    ).toBe("leak");
    const leakyContract = { ...CONTRACT, run: ["node", "dist/cache.js", "--tag", "zebra quokka"] };
    expect(
      errorCode(() => runDecideResolve(loc, f.workId, "d-interface", { choice: "A command line program", rationale: "Callers shell out.", rejected: [], interface: leakyContract }, HUMAN)),
      "resolve: interface argv",
    ).toBe("leak");

    expect(rejections().length - before).toBe(4);
    expect(JSON.stringify(rejections().map((e) => e.payload))).not.toMatch(/zebra|quokka/i);
    expect(findDecision(reportAt(f, NOW).state, "d-cache")?.status).toBe("open");
    expect(findDecision(reportAt(f, NOW).state, "d-qas")).toBeNull();
  });

  it("keeps every canary out of spec.md, decision events, needs-human.json and CLI output", () => {
    const f = leakFixture();
    resolveOpen(f, "d-cache");
    const refusals: string[] = [];
    for (const [index, [, text]] of PLANTS.entries()) {
      const file = writeJson(f, `plant-${index}.json`, { id: `d-cli-${index}`, class: "other", question: `${text}?` });
      const run = decideCli(f, ["add", f.workId, "--file", file]);
      expect(run.code, run.stderr).toBe(1);
      refusals.push(run.stdout, run.stderr);
    }
    const lint = decideCli(f, ["lint", f.workId]);
    const show = decideCli(f, ["show", f.workId]);

    const surfaces: Record<string, string> = {
      "spec.md": readFileSync(specFile(f.item.dir), "utf8"),
      "decision events": decisionEvents(f).map((e) => JSON.stringify(e.payload)).join("\n"),
      "needs-human.json": readFileSync(needsHumanFile(f.item.dir), "utf8"),
      "refused add output": refusals.join("\n"),
      "lint output": lint.stdout + lint.stderr,
      "show output": show.stdout + show.stderr,
    };
    for (const [name, text] of Object.entries(surfaces)) expect(canaryHits(text), name).toEqual([]);

    // Not vacuous: the canaries exist on the host, the decisions exist, and the rejections were recorded.
    expect(canaryHits(readFileSync(goalFile(f.fx.location.dir, f.fx.goalId), "utf8"))).toEqual(expect.arrayContaining(["target"]));
    expect(canaryHits(payloadText(f.fx, "metric.measured"))).toEqual(expect.arrayContaining(["reading"]));
    expect(surfaces["spec.md"]).toContain("d-cache");
    expect(decisionEvents(f).filter((e) => e.type === "decision.rejected")).toHaveLength(PLANTS.length);

    // The projection names no goal, no signer and no e-mail address (spec.md is shown to the implementer and the verifier).
    expect(surfaces["spec.md"]).not.toContain(f.fx.goalId);
    expect(surfaces["spec.md"]).not.toMatch(/@/);
  });

  it("withholds a record from spec.md after a goal re-lock makes it leak, and GATE-1 blocks", () => {
    const f = setupDecisionItem();
    closeInterface(f);
    addOpen(f, "d-cache");
    runDecideResolve(f.fx.location, f.workId, "d-cache", { choice: "Keep 2500 entries", rationale: "That is the size callers use.", rejected: [] }, HUMAN);
    expect(readFileSync(specFile(f.item.dir), "utf8")).toContain("Keep 2500 entries");

    relockTarget(f, 2500);
    decideCli(f, ["lint", f.workId, "--render"]);
    const spec = readFileSync(specFile(f.item.dir), "utf8");
    expect(spec).not.toContain("2500");
    expect(spec).toMatch(/record withheld \(leak\) #\d+/);
    expect(reasonsOf(reportAt(f, NOW).gate)).toContainEqual({ code: "record_invalid", decision_id: "d-cache", problem: "leak" });
  });
});
