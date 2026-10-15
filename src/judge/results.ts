import { join } from "node:path";
import { writePrivateFileAtomic } from "../core/private-fs.js";
import type { DecisionState } from "../decision/types.js";
import { categoryOf } from "../feedback/tally.js";
import type { ScenarioResult } from "../feedback/types.js";
import type { StoredScenario } from "../scenario/types.js";
import { scenarioRef } from "../scenario/types.js";
import type { JudgeRoundFacts } from "./events.js";
import { harnessScenarioOf } from "./harness-protocol.js";
import type { RoundScenario, RoundVerdict, ScenarioTally } from "./round.js";

/**
 * The real mapper: tallies to the closed `ScenarioResult` feedback may see. Behavior scenarios only; canaries
 * are judged for GATE-3 and never scored. `passed` = every one of the k repetitions passed, `flaky` = they disagreed. An
 * `error` verdict was already turned into a thrown round error, so reaching here with one is a bug and stops the line.
 */
export function toScenarioResults(tallies: readonly ScenarioTally[]): ScenarioResult[] {
  const results: ScenarioResult[] = [];
  for (const tally of tallies) {
    if (tally.kind !== "behavior") continue;
    if (tally.verdict === "error") throw new Error("an error verdict never reaches the mapper");
    results.push({ category: tally.category, passed: tally.verdict === "pass", flaky: tally.verdict === "flaky" });
  }
  return results;
}

const byId = (a: StoredScenario, b: StoredScenario): number =>
  a.scenario_id < b.scenario_id ? -1 : a.scenario_id > b.scenario_id ? 1 : 0;

/**
 * Projects the ACTIVE scenarios of the standing set (the caller applies the ledger statuses) to what the harness may hold:
 * steps and expectations under the scenario ref. No id, canary, author, decision ref or assertion note leaves here. The
 * category is the class of the linked decisions (spec §5.7). Sorted by id, so the order is stable.
 */
export function harnessSetOf(scenarios: readonly StoredScenario[], state: DecisionState): RoundScenario[] {
  const classOf = new Map(state.decisions.map((decision) => [decision.id, decision.class] as const));
  return [...scenarios].sort(byId).map((scenario): RoundScenario => {
    const linked = scenario.decision_refs.flatMap((ref) => {
      const cls = classOf.get(ref);
      return cls === undefined ? [] : [cls];
    });
    const ref = scenarioRef(scenario.scenario_id);
    return {
      scenario_ref: ref,
      split: scenario.split,
      kind: scenario.kind,
      category: categoryOf(linked),
      set: harnessScenarioOf(scenario),
    };
  });
}

/** The counts `judge.round_completed` records for one judged phase; the per-scenario tallies stay in the host-only file. */
export function roundFacts(verdict: RoundVerdict): JudgeRoundFacts {
  return {
    phase: verdict.phase,
    candidate_sha: verdict.candidate_sha,
    k: verdict.k,
    scenarios_total: verdict.counts.total,
    pass: verdict.counts.pass,
    fail: verdict.counts.fail,
    flaky: verdict.counts.flaky,
    error: verdict.counts.error,
    contradiction_scenarios: verdict.contradiction.scenarios,
    contradiction_rejected: verdict.contradiction.rejected,
    harness_context_sha256: verdict.harness_context_sha256,
    sut_base_digest: verdict.sut_base_digest,
    harness_base_digest: verdict.harness_base_digest,
  };
}

/**
 * Writes the host-only view of one judged split, `runs/<run_id>/judge-<round>-<phase>.json`: the per-scenario tallies by
 * scenario ref, with no text and no id. Private to the host (mode 0600, written atomically); nothing the implementer reads
 * is built from it.
 */
export function writeTallyView(
  itemDir: string,
  input: {
    runId: string;
    round: number;
    phase: "train" | "test";
    candidateSha: string;
    tallies: readonly ScenarioTally[];
  },
): void {
  const tallies = input.tallies.map((t) => ({
    scenario_ref: t.scenario_ref,
    kind: t.kind,
    verdict: t.verdict,
    outcomes: t.outcomes,
  }));
  const view = {
    schema_version: 1,
    round: input.round,
    phase: input.phase,
    candidate_sha: input.candidateSha,
    tallies,
  };
  writePrivateFileAtomic(
    join(itemDir, "runs", input.runId, `judge-${input.round}-${input.phase}.json`),
    `${JSON.stringify(view, null, 2)}\n`,
  );
}
