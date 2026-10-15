import { createHash } from "node:crypto";
import type { DecisionClass } from "../../src/decision/types.js";
import { categoryOf } from "../../src/feedback/tally.js";
import type { ScenarioResult } from "../../src/feedback/types.js";
import { pick, seededRng } from "./feedback.js";

/**
 * Strings that must never leave the host through the feedback path (spec §5.7, §4.6 F6). They are planted in a
 * scenario's id, input, expected output and assertion text. The numbers cannot equal anything feedback may print:
 * a released percentage is 0 to 100 and a count is a few dozen, while these are a decimal and six digits.
 */
export const FB_CANARY = {
  guid: "5d0c7e1a-9b3f-4a62-8e17-c4f2a6b93d08",
  scenarioId: "s-7a3f9c1e5b2d48a6c0e9f1b37d5a8c24",
  decimal: "7731.4159",
  longInteger: "906482",
  words: ["heliotrope", "marmoset"],
} as const;

const DECIMAL_INTEGER_PART = FB_CANARY.decimal.slice(0, FB_CANARY.decimal.indexOf("."));

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `value` as a whole token: not glued to letters or digits, so a hex digest that happens to hold the digits is not a hit. */
export function containsToken(text: string, value: string): boolean {
  return new RegExp(`(?<![0-9A-Za-z])${escapeRegExp(value)}(?![0-9A-Za-z])`, "i").test(text);
}

const NEEDLES: readonly { label: string; hit: (text: string) => boolean }[] = [
  { label: "guid", hit: (text) => containsToken(text, FB_CANARY.guid) },
  { label: "scenario id", hit: (text) => containsToken(text, FB_CANARY.scenarioId) },
  { label: "scenario id shape", hit: (text) => /(?<![0-9A-Za-z])s-[0-9a-f]{32}(?![0-9A-Za-z])/.test(text) },
  { label: "decimal", hit: (text) => containsToken(text, FB_CANARY.decimal) },
  { label: "decimal digits", hit: (text) => containsToken(text, DECIMAL_INTEGER_PART) },
  { label: "long integer", hit: (text) => containsToken(text, FB_CANARY.longInteger) },
  { label: `word ${FB_CANARY.words[0]}`, hit: (text) => containsToken(text, FB_CANARY.words[0]) },
  { label: `word ${FB_CANARY.words[1]}`, hit: (text) => containsToken(text, FB_CANARY.words[1]) },
];

export const FB_CANARY_LABELS: readonly string[] = NEEDLES.map((needle) => needle.label);

/** The label of every fixed canary found in `text`, in `FB_CANARY_LABELS` order, each once. Empty means no leak. */
export function fbCanaryHits(text: string): string[] {
  return NEEDLES.filter((needle) => needle.hit(text)).map((needle) => needle.label);
}

/** `pick` and the seeded PRNG come from `./feedback.ts`; this file re-exports the PRNG as `mulberry32`, the name its tests use. */
export { pick, seededRng as mulberry32 };

function hex(random: () => number, length: number): string {
  return Array.from({ length }, () => "0123456789abcdef".charAt(Math.floor(random() * 16))).join("");
}

// ---- The fake vault: the objects a real judge station would read. Nothing here is a src/ type. ----

export interface FakeStep {
  argv: string[];
  stdin: string;
  expect_stdout: string;
  note: string;
}
export interface FakeVaultScenario {
  scenario_id: string;
  split: "train" | "test";
  decision_refs: string[];
  step: FakeStep;
}
/** One boolean per repetition of the judge (k). */
export interface FakeVerdict {
  scenario_id: string;
  reps: boolean[];
}

/** Decision id to class, the lookup M3a's fold gives the real station. */
export const FAKE_DECISION_CLASS: ReadonlyMap<string, DecisionClass> = new Map<string, DecisionClass>([
  ["d-interface", "interface"],
  ["d-compat", "compatibility"],
  ["d-model", "data_model"],
  ["d-errors", "error_semantics"],
  ["d-security", "security"],
  ["d-misc", "other"],
]);
export const LINKABLE_REFS: readonly (readonly string[])[] = [
  ["d-interface"],
  ["d-interface", "d-compat"],
  ["d-interface", "d-errors"],
  ["d-model"],
  ["d-security"],
  ["d-misc"],
];

const WORDS = ["heliotrope", "marmoset", "quillwort", "zanzibar", "obelisk", "tamarind", "gnomon"];

/**
 * A scenario with a canary in its id, its input (argv and stdin), its expected output and its assertion note. The
 * first train scenario of a set carries the fixed canaries; the others get random values of the same shape.
 */
export function plantedScenario(
  random: () => number,
  index: number,
  refs: readonly string[],
  split: "train" | "test" = "train",
): FakeVaultScenario {
  const fixed = index === 0 && split === "train";
  const digits = (low: number, span: number): string => String(low + Math.floor(random() * span));
  return {
    scenario_id: fixed ? FB_CANARY.scenarioId : `s-${hex(random, 32)}`,
    split,
    decision_refs: [...refs],
    step: {
      argv: ["run", fixed ? FB_CANARY.guid : [8, 4, 4, 4, 12].map((n) => hex(random, n)).join("-")],
      stdin: fixed ? FB_CANARY.words.join(" ") : `${pick(random, WORDS)} ${pick(random, WORDS)}`,
      expect_stdout: fixed ? FB_CANARY.decimal : `${digits(1000, 9000)}.${digits(1000, 9000)}`,
      note: fixed ? FB_CANARY.longInteger : digits(100000, 900000),
    },
  };
}

/** Every value planted in one scenario, for substring checks. */
export function plantedOf(scenario: FakeVaultScenario): string[] {
  return [
    scenario.scenario_id,
    scenario.step.argv[1] ?? "",
    ...scenario.step.stdin.split(" "),
    scenario.step.expect_stdout,
    scenario.step.note,
  ].filter((value) => value !== "");
}

export function makeSet(
  random: () => number,
  layout: readonly { refs: readonly string[]; count: number }[],
  split: "train" | "test" = "train",
): FakeVaultScenario[] {
  const scenarios: FakeVaultScenario[] = [];
  for (const { refs, count } of layout) {
    for (let n = 0; n < count; n += 1) scenarios.push(plantedScenario(random, scenarios.length, refs, split));
  }
  return scenarios;
}

/** Stands in for the vault's digest of the split: sha256 over the sorted opaque ids. A hex digest holds no id text. */
export function digestOf(ids: readonly string[]): string {
  return createHash("sha256")
    .update([...ids].sort().join("\n"))
    .digest("hex");
}

/** k = 3 repetitions: `passing` indexes pass all three, `flaky` indexes disagree, the rest fail all three. */
export function verdictsFor(
  scenarios: readonly FakeVaultScenario[],
  passing: ReadonlySet<number>,
  flaky: ReadonlySet<number> = new Set(),
): FakeVerdict[] {
  return scenarios.map((scenario, index) => ({
    scenario_id: scenario.scenario_id,
    reps: flaky.has(index) ? [true, false, true] : passing.has(index) ? [true, true, true] : [false, false, false],
  }));
}

export function randomVerdicts(random: () => number, scenarios: readonly FakeVaultScenario[]): FakeVerdict[] {
  const patterns = [
    [true, true, true],
    [false, false, false],
    [true, false, true],
  ];
  return scenarios.map((scenario) => ({ scenario_id: scenario.scenario_id, reps: pick(random, patterns) }));
}

/**
 * The TEST-LOCAL mapper (partial coverage, see the README row): scenario plus verdict to the closed `ScenarioResult`.
 * It drops the id, which is what the M3f judge station must do; that station is not covered by this test.
 */
export function toResults(scenarios: readonly FakeVaultScenario[], verdicts: readonly FakeVerdict[]): ScenarioResult[] {
  const byId = new Map(verdicts.map((verdict) => [verdict.scenario_id, verdict]));
  return scenarios.map((scenario) => {
    const verdict = byId.get(scenario.scenario_id);
    if (verdict === undefined) throw new Error("the fake verdict list has no entry for a scenario");
    const linked = scenario.decision_refs.flatMap((ref) => {
      const cls = FAKE_DECISION_CLASS.get(ref);
      return cls === undefined ? [] : [cls];
    });
    const passes = verdict.reps.filter(Boolean).length;
    return {
      category: categoryOf(linked),
      passed: passes === verdict.reps.length,
      flaky: passes > 0 && passes < verdict.reps.length,
    };
  });
}
