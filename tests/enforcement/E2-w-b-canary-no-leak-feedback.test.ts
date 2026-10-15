import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { declareBudget } from "../../src/core/budget.js";
import { Ledger } from "../../src/core/ledger.js";
import { DECISION_CLASSES } from "../../src/decision/types.js";
import { isAllowlistedFeedback } from "../../src/feedback/render.js";
import { releaseFeedback } from "../../src/feedback/release.js";
import { parseScenarioResults } from "../../src/feedback/tally.js";
import { FeedbackError } from "../../src/feedback/types.js";
import { ledgerEvents, reconcileInputs, reconcileTexts } from "../helpers/enforcement-goal.js";
import {
  FB_CANARY_LABELS,
  LINKABLE_REFS,
  containsToken,
  digestOf,
  fbCanaryHits,
  mulberry32,
  pick,
  plantedOf,
  plantedScenario,
  randomVerdicts,
  toResults,
  verdictsFor,
} from "../helpers/feedback-canary.js";
import { type FeedbackPipelineRun, HOST_FILE_NAME, runFeedbackPipeline } from "../helpers/feedback-pipeline.js";
import { makeTempDir } from "../helpers/tmp.js";
import { joinTree, readTree } from "../helpers/tree.js";

// Spec §5.7, §4.6 F6: the implementer, the goal loop and the evidence files get percentages, counts and class
// names, never a scenario's id, input, expected output or assertion. PARTIAL: the scenario-to-ScenarioResult
// mapper here is test-local (tests/helpers/feedback-canary.ts). The real mapper is the M3f judge station.

/** Fails with the surface's name and the canaries found in it, so a leak says where it went. */
function expectNoFbCanary(surfaces: Record<string, string>): void {
  for (const [name, text] of Object.entries(surfaces)) expect(fbCanaryHits(text), name).toEqual([]);
}

function thrown(fn: () => unknown): FeedbackError {
  try {
    fn();
  } catch (error) {
    if (error instanceof FeedbackError) return error;
    throw error;
  }
  throw new Error("expected the call to throw");
}

describe("E2-W-b canary-no-leak, feedback side (partial: test-local mapper)", () => {
  describe("the closed input", () => {
    const scenario = plantedScenario(mulberry32(1), 0, ["d-interface"]);

    it("refuses a whole vault scenario without echoing any of it", () => {
      const error = thrown(() => parseScenarioResults([scenario]));
      expect(error.code).toBe("invalid_input");
      expect(fbCanaryHits(error.message)).toEqual([]);
    });

    it.each(["scenario_id", "input", "expected", "canary"])("refuses a result row with an extra %s key without echoing it", (key) => {
      const row = { category: "interface", passed: true, flaky: false, [key]: JSON.stringify(scenario) };
      const error = thrown(() => parseScenarioResults([row]));
      expect(error.code).toBe("invalid_input");
      expect(fbCanaryHits(error.message)).toEqual([]);
    });

    it("accepts what the test-local mapper builds: three keys and no id", () => {
      const results = toResults([scenario], verdictsFor([scenario], new Set([0])));
      expect(Object.keys(results[0] ?? {}).sort()).toEqual(["category", "flaky", "passed"]);
      expect(parseScenarioResults(results)).toEqual(results);
      expect(fbCanaryHits(JSON.stringify(results))).toEqual([]);
    });
  });

  describe("the pipeline over a planted train set", () => {
    let run: FeedbackPipelineRun;
    beforeAll(() => {
      run = runFeedbackPipeline();
    }, 120_000);

    it("plants the canaries on the host and runs four rounds, a test split and a reseal", () => {
      // Positive controls: the canaries exist in the vault objects and in the host file, so a clean scan means something.
      expect(fbCanaryHits(JSON.stringify([...run.train, ...run.test]))).toEqual(FB_CANARY_LABELS);
      expect(fbCanaryHits(readFileSync(run.hostFile, "utf8"))).toEqual(FB_CANARY_LABELS);
      expect(run.rounds.map((round) => round.kinds)).toEqual([
        ["first", "first"],
        ["repeat", "repeat"],
        ["new", "repeat"],
        ["repeat", "repeat"],
      ]);
      expect(run.rounds.map((round) => round.units)).toEqual([1, 0, 1, 0]);
      expect(run.rounds[0]?.text).toMatch(/^- interface: 33% of 6 scenarios$/m);
      expect(run.rounds[0]?.text).toMatch(/^- error_semantics: 16% of 6 scenarios$/m);
      expect(run.rounds[2]?.text).toMatch(/^- interface: 83% of 6 scenarios$/m);
      expect(run.rounds[3]?.text).toMatch(/^- interface: 83% of 6 scenarios$/m);
      for (const type of ["feedback.released", "feedback.test_run_consumed", "feedback.test_run_completed", "feedback.test_reseal_authorized"]) {
        expect(ledgerEvents(run.fx, type).length, type).toBe(type === "feedback.released" ? 4 : 1);
      }
      // Two W units and two reconcile ticks draw from the one per-goal pool.
      expect(ledgerEvents(run.fx, "budget.consumed").filter((e) => e.payload.kind === "disclosure")).toHaveLength(4);
    });

    it("keeps every canary out of the rendered feedback, the feedback and budget payloads and the ledger", () => {
      const payloads = ledgerEvents(run.fx)
        .filter((event) => event.type.startsWith("feedback.") || event.type.startsWith("budget."))
        .map((event) => JSON.stringify(event.payload))
        .join("\n");
      expect(payloads.length).toBeGreaterThan(0);
      for (const round of run.rounds) expect(isAllowlistedFeedback(round.text)).toBe(true);
      expectNoFbCanary({
        "rendered feedback": run.rounds.map((round) => round.text).join("\n"),
        "feedback and budget payloads": payloads,
        "ledger file": readFileSync(run.fx.ledger.file, "utf8"),
      });
    });

    it("keeps them out of the whole host state tree except the one planted file", () => {
      const tree = readTree(run.fx.location.dir);
      expect(tree.has(HOST_FILE_NAME), "the planted host file is in the tree").toBe(true);
      tree.delete(HOST_FILE_NAME);
      expect(tree.size).toBeGreaterThan(5);
      expectNoFbCanary({ "host state tree": joinTree(tree) });
    });

    it("keeps them out of the next reconcile input, the model's stdin and the CLI output", () => {
      const types = ledgerEvents(run.fx).map((event) => event.type);
      expect(types.lastIndexOf("feedback.released"), "the second tick came after the releases").toBeLessThan(types.lastIndexOf("reconcile.requested"));
      const inputs = reconcileInputs(run.fx);
      expect(inputs).toHaveLength(2);
      for (const input of inputs) {
        expect(input.recent_outcomes).toEqual({ success: 0, flawed: 0, blocked: 0, manual: 0 });
        expect(Object.keys(input).filter((key) => /feedback|score|ladder/i.test(key))).toEqual([]);
      }
      expectNoFbCanary({
        "first tick stdout": run.tick1.stdout,
        "first tick stderr": run.tick1.stderr,
        "second tick stdout": run.tick2.stdout,
        "second tick stderr": run.tick2.stderr,
        "goal status": `${run.status.stdout}\n${run.status.stderr}`,
        "work list": `${run.list.stdout}\n${run.list.stderr}`,
        "reconciler stdin": readFileSync(join(run.fx.record, "stdin.txt"), "utf8"),
        "reconcile input files": reconcileTexts(run.fx, "input").join("\n"),
      });
    });

    it("keeps them out of the evidence values M3d produces and the evidence files built from them", () => {
      expect(run.trainCounts).toEqual({ pass: 6, total: 12, flaky: 1 });
      expect(run.noise).toMatchObject({ status: "not_evaluated", force_not_recommended: true, reason: "flaky_scenarios" });
      expect(run.sealedTest).toEqual({ pass: 6, total: 8, flaky: 1 });
      const doc = JSON.parse(run.evidence.json) as { sealed: { train: unknown; test: unknown } };
      expect(doc.sealed.train, "the counts reached the evidence file").toEqual(run.trainCounts);
      expect(doc.sealed.test).toEqual({ pass: 6, total: 8 });
      expectNoFbCanary({
        "M3d evidence values": JSON.stringify({ train: run.trainCounts, noise: run.noise, sealedTest: run.sealedTest }),
        "evidence.json": run.evidence.json,
        "evidence.md": run.evidence.md,
      });
    });
  });

  describe("the property loop (seeded, 200 iterations)", () => {
    const TEMPLATE_WORDS = ["Masked", "feedback", "from", "the", "train", "scenarios", "of", "No", "other", "information", "about", "is", "available"];

    it("releases only template words, class names, percentages and counts, whatever the scenarios say", () => {
      const random = mulberry32(20261014);
      const words = new Set<string>([...DECISION_CLASSES, ...TEMPLATE_WORDS]);
      for (let i = 0; i < 200; i += 1) {
        const count = 5 + Math.floor(random() * 36);
        const scenarios = Array.from({ length: count }, (_, index) => plantedScenario(random, index, pick(random, LINKABLE_REFS)));
        const ledger = new Ledger(makeTempDir("omf-fb-prop-"));
        declareBudget(ledger, "g-prop", "disclosure", 3, "human:dev");
        const released = releaseFeedback(ledger, {
          goalId: "g-prop",
          workId: "w-0123456789ab",
          runId: "r-20261014T100000Z-0001",
          trainDigest: digestOf(scenarios.map((s) => s.scenario_id)),
          results: toResults(scenarios, randomVerdicts(random, scenarios)),
        });
        if (released.status !== "released") throw new Error(`iteration ${i}: withheld (${released.reason})`);

        const text = released.feedback.text;
        const allowed = new Set(released.host_only.categories.flatMap((c) => [String(c.score_pct), String(c.n)]));
        expect(isAllowlistedFeedback(text), `iteration ${i}`).toBe(true);
        expect((text.match(/[0-9]+/g) ?? []).filter((digits) => !allowed.has(digits)), `iteration ${i}: stray digit runs`).toEqual([]);
        expect((text.match(/[A-Za-z_]+/g) ?? []).filter((word) => !words.has(word)), `iteration ${i}: stray words`).toEqual([]);
        const surfaces = `${text}\n${readFileSync(ledger.file, "utf8")}`;
        expect(scenarios.flatMap(plantedOf).filter((value) => containsToken(surfaces, value)), `iteration ${i}: planted values`).toEqual([]);
      }
    }, 120_000);
  });

  it.todo("M3f: re-run this canary set from vault scenarios through the real judge-station mapper, which must drop the ids");
});
