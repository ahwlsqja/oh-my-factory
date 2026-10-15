import { canonicalize, sha256Hex } from "../core/canonical-json.js";
import { validateDef } from "../core/schema.js";
import type { DecisionLinks } from "../decision/lint.js";
import { isQuantitative } from "../decision/types.js";
import type { DecisionRecord, DecisionState } from "../decision/types.js";
import type { EffectiveScenario } from "./events.js";
import { evaluateExpect } from "./matcher.js";
import { isCanaryKind, scenarioRef } from "./types.js";
import type { AuthorStamp, Expect, ScenarioStep, StoredScenario } from "./types.js";

/**
 * Host-side lint of one sealed scenario set (spec §5.3, M3c-D8, M3c-D17, M3c-D19). Pure: the caller reads the vault and the
 * ledger and passes the result in, so the same function judges a fresh seal, a re-read set and a test double.
 */

export type ScenarioProblemCode =
  | "schema_invalid"
  | "work_mismatch"
  | "duplicate_id"
  | "author_mismatch"
  | "no_decision_ref"
  | "unknown_decision_ref"
  | "decision_not_resolved"
  | "decision_quantitative"
  | "expect_empty"
  | "canary_in_invoke"
  | "canary_missing_from_note"
  | "canary_satisfiable"
  | "contradiction";

/** `scenario_ref` and `decision_id` only; never the text that triggered the problem (M3c-D10, so a list of these is ledger-safe). */
export interface ScenarioProblem {
  code: ScenarioProblemCode;
  scenario_ref: string | null;
  decision_id?: string;
}

export interface LintInput {
  scenarios: readonly EffectiveScenario[];
  state: DecisionState;
  workId: string;
  /** The author stamp recorded in `seal.completed`: OMF's own statement, which every file must repeat. */
  sealedAuthor: AuthorStamp;
}

/** A step asserts nothing when no exit code, no stdout match and no (non-empty) json_path is set. A note alone is text, not an assertion. */
function isEmptyExpect(expectation: Expect): boolean {
  const noPath = expectation.json_path === null || Object.keys(expectation.json_path).length === 0;
  return expectation.exit_code === null && expectation.stdout_matches === null && noPath;
}

/**
 * True when no implementation can pass this step: stdout is pinned to one exact text AND json_path entries are set that the text
 * itself fails. The observation is built from the exact text with the step's own exit code (or 0), so the exit-code and stdout
 * checks pass by construction and a failing verdict can only come from the json_path. An anchored pattern matches many outputs, so it never qualifies.
 */
function stepIsUnsatisfiable(step: ScenarioStep): boolean {
  const { stdout_matches: match, json_path: path } = step.expect;
  if (match === null || match.kind !== "exact" || path === null) return false;
  const verdict = evaluateExpect(step.expect, { outcome: "exited", exit_code: step.expect.exit_code ?? 0, stdout: match.text });
  return !verdict.pass;
}

/** expect_empty / canary_missing_from_note for a scenario that failed the schema, only when its shape is otherwise readable. */
function namedExpectFaults(scenario: StoredScenario, ref: string): ScenarioProblem[] {
  const steps: unknown = scenario.steps;
  const canary: unknown = scenario.canary;
  if (!Array.isArray(steps) || typeof canary !== "string") return [];
  const problems: ScenarioProblem[] = [];
  const expects = steps.map((step: unknown) => (step as { expect?: Expect } | null)?.expect);
  if (expects.some((e) => e === undefined || e === null || typeof e !== "object")) return [];
  if (expects.some((e) => isEmptyExpect(e as Expect))) problems.push({ code: "expect_empty", scenario_ref: ref });
  if (expects.some((e) => typeof (e as Expect).note !== "string" || !(e as Expect).note.startsWith(canary))) {
    problems.push({ code: "canary_missing_from_note", scenario_ref: ref });
  }
  return problems;
}

function refProblems(scenario: StoredScenario, ref: string, decisions: ReadonlyMap<string, DecisionRecord>): ScenarioProblem[] {
  const problems: ScenarioProblem[] = [];
  if (scenario.kind === "behavior" && scenario.decision_refs.length === 0) {
    problems.push({ code: "no_decision_ref", scenario_ref: ref });
  }
  for (const id of scenario.decision_refs) {
    const decision = decisions.get(id);
    if (decision === undefined) problems.push({ code: "unknown_decision_ref", scenario_ref: ref, decision_id: id });
    else if (decision.status !== "resolved") problems.push({ code: "decision_not_resolved", scenario_ref: ref, decision_id: id });
    else if (isQuantitative(decision.class)) problems.push({ code: "decision_quantitative", scenario_ref: ref, decision_id: id });
  }
  return problems;
}

function bodyProblems(scenario: StoredScenario, ref: string): ScenarioProblem[] {
  const problems: ScenarioProblem[] = [];
  if (scenario.steps.some((step) => isEmptyExpect(step.expect))) problems.push({ code: "expect_empty", scenario_ref: ref });
  const inInvoke = scenario.steps.some((step) => [...step.invoke.argv, step.invoke.stdin].some((text) => text.includes(scenario.canary)));
  if (inInvoke) problems.push({ code: "canary_in_invoke", scenario_ref: ref });
  if (scenario.steps.some((step) => !step.expect.note.startsWith(scenario.canary))) {
    problems.push({ code: "canary_missing_from_note", scenario_ref: ref });
  }
  if (isCanaryKind(scenario) && !scenario.steps.some(stepIsUnsatisfiable)) {
    problems.push({ code: "canary_satisfiable", scenario_ref: ref });
  }
  return problems;
}

/**
 * Per scenario, in input order: stored_scenario schema (a malformed one is reported and checked no further); work id equals;
 * ids unique (across active and inactive); author equals the seal event's; decision references (`refProblems`); a non-empty expect
 * on every step; the canary absent from every invoke and the prefix of every note; a contradiction_canary statically
 * unsatisfiable. Retired and contaminated scenarios are skipped after the id check. Then the set-level `contradictions`, one
 * problem per pair on the earlier scenario (a caller that needs the partner calls `contradictions` itself).
 */
export function lintScenarioSet(input: LintInput): ScenarioProblem[] {
  const problems: ScenarioProblem[] = [];
  const decisions = new Map(input.state.decisions.map((decision) => [decision.id, decision]));
  const sealedAuthor = canonicalize(input.sealedAuthor);
  const seenIds = new Set<string>();
  const wellFormed: EffectiveScenario[] = [];

  for (const item of input.scenarios) {
    const scenario = item.scenario;
    const id: unknown = scenario.scenario_id;
    const ref = typeof id === "string" ? scenarioRef(id) : null;
    if (typeof id === "string") {
      if (seenIds.has(id)) problems.push({ code: "duplicate_id", scenario_ref: ref });
      seenIds.add(id);
    }
    if (item.status !== "active") continue;

    if (!validateDef("scenario.schema.json", "stored_scenario", scenario).ok || ref === null) {
      // The stored_scenario schema also rejects an empty expect and a note without the canary prefix; name those two faults
      // precisely instead of the generic code, so the caller learns what to fix.
      const specific = ref === null ? [] : namedExpectFaults(scenario, ref);
      problems.push(...(specific.length > 0 ? specific : [{ code: "schema_invalid" as const, scenario_ref: ref }]));
      continue;
    }
    if (scenario.work_id !== input.workId) problems.push({ code: "work_mismatch", scenario_ref: ref });
    if (canonicalize(scenario.author) !== sealedAuthor) problems.push({ code: "author_mismatch", scenario_ref: ref });
    problems.push(...refProblems(scenario, ref, decisions), ...bodyProblems(scenario, ref));
    wellFormed.push(item);
  }

  for (const pair of contradictions(wellFormed)) problems.push({ code: "contradiction", scenario_ref: pair.scenario_ref_a });
  return problems;
}

interface Demand {
  index: number;
  exit_code: number | null;
  exact: string | null;
}

/** sha256 of every {argv, stdin} from step 0 through step `upTo`: the state a step runs in is the sequence that led to it (M3c-D19). */
function prefixKey(steps: readonly ScenarioStep[], upTo: number): string {
  return sha256Hex(canonicalize(steps.slice(0, upTo + 1).map((step) => ({ argv: step.invoke.argv, stdin: step.invoke.stdin }))));
}

function conflicts(a: Demand, b: Demand): boolean {
  if (a.exit_code !== null && b.exit_code !== null && a.exit_code !== b.exit_code) return true;
  return a.exact !== null && b.exact !== null && a.exact !== b.exact;
}

/**
 * Two active behavior scenarios whose steps share a canonical invoke PREFIX and demand a different exit_code or a different exact
 * stdout. `list` after `add x` and a bare `list` have different prefixes and are never compared. Canaries contradict on purpose and
 * are excluded, as are retired and contaminated scenarios. Pairs come out once, earlier scenario (input order) first.
 */
export function contradictions(scenarios: readonly EffectiveScenario[]): { scenario_ref_a: string; scenario_ref_b: string }[] {
  const active = scenarios.filter((item) => item.status === "active" && item.scenario.kind === "behavior");
  const byKey = new Map<string, Demand[]>();
  active.forEach((item, index) => {
    item.scenario.steps.forEach((step, i) => {
      const match = step.expect.stdout_matches;
      const demand: Demand = { index, exit_code: step.expect.exit_code, exact: match !== null && match.kind === "exact" ? match.text : null };
      const key = prefixKey(item.scenario.steps, i);
      const list = byKey.get(key);
      if (list === undefined) byKey.set(key, [demand]);
      else list.push(demand);
    });
  });

  const pairs = new Map<string, [number, number]>();
  for (const list of byKey.values()) {
    for (const [i, a] of list.entries()) {
      for (const b of list.slice(i + 1)) {
        if (a.index !== b.index && conflicts(a, b)) pairs.set(`${Math.min(a.index, b.index)}:${Math.max(a.index, b.index)}`, [Math.min(a.index, b.index), Math.max(a.index, b.index)]);
      }
    }
  }
  return [...pairs.values()]
    .sort((x, y) => x[0] - y[0] || x[1] - y[1])
    .map(([a, b]) => ({ scenario_ref_a: scenarioRef(active[a]!.scenario.scenario_id), scenario_ref_b: scenarioRef(active[b]!.scenario.scenario_id) }));
}

/**
 * What spec §5.2 calls the host-side link check: the decision ids named by active behavior scenarios. A canary that names a
 * decision is not coverage (it is built to fail), and a retired or contaminated scenario no longer covers anything. The result
 * plugs into `lintDecisions(..., links)` and `scenarioLinkCoverage(state, links.linkedDecisionIds())`.
 */
export function vaultDecisionLinks(scenarios: readonly EffectiveScenario[]): DecisionLinks {
  const linked = new Set<string>();
  for (const item of scenarios) {
    if (item.status !== "active" || item.scenario.kind !== "behavior") continue;
    for (const id of item.scenario.decision_refs) linked.add(id);
  }
  return { linkedDecisionIds: () => linked };
}
