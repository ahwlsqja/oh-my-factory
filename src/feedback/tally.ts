import { DECISION_CLASSES, isQuantitative } from "../decision/types.js";
import type { DecisionClass } from "../decision/types.js";
import { FeedbackError, MIN_CATEGORY_SIZE } from "./types.js";
import type { CategoryTally, ScenarioResult } from "./types.js";

const ALLOWED_KEYS: readonly string[] = ["category", "flaky", "passed"];

/** The message holds the index and a fixed reason word, never a value or a key text from the caller (E2-W-b). */
function refuse(index: number, reason: string): never {
  throw new FeedbackError("invalid_input", `scenario result ${index} refused: ${reason}`);
}

function parseOne(item: unknown, index: number): ScenarioResult {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return refuse(index, "not_an_object");
  const record = item as Record<string, unknown>;
  if (Object.keys(record).some((key) => !ALLOWED_KEYS.includes(key))) return refuse(index, "extra_key");
  if (ALLOWED_KEYS.some((key) => !Object.hasOwn(record, key))) return refuse(index, "missing_key");
  const { category, passed, flaky } = record;
  if (typeof category !== "string" || !(DECISION_CLASSES as readonly string[]).includes(category)) {
    return refuse(index, "unknown_category");
  }
  const cls = category as DecisionClass;
  if (isQuantitative(cls)) return refuse(index, "quantitative_category");
  if (typeof passed !== "boolean" || typeof flaky !== "boolean") return refuse(index, "not_boolean");
  if (passed && flaky) return refuse(index, "flaky_and_passed");
  return { category: cls, passed, flaky };
}

/**
 * Validates an untrusted array into the closed input. Exactly the three keys, booleans, a linkable DecisionClass, flaky
 * implies !passed. Any extra key (a scenario id, an input, an expected output) is refused with FeedbackError("invalid_input"),
 * so a caller that passes a whole scenario fails here instead of leaking through. Quantitative classes are refused too: they
 * are not linkable to CLI scenarios in v0.1 (M3-D17).
 */
export function parseScenarioResults(value: unknown): ScenarioResult[] {
  if (!Array.isArray(value)) throw new FeedbackError("invalid_input", "scenario results must be an array");
  return value.map((item: unknown, index) => parseOne(item, index));
}

/**
 * Category of a scenario from the classes its decisions link: the first linked class in DECISION_CLASSES order that is
 * neither "interface" nor quantitative; else "interface" if linked; else "other". "interface" is mandatory and most scenarios
 * link it, so letting it win would put nearly everything on one line (M3d-D3).
 */
export function categoryOf(linkedClasses: readonly DecisionClass[]): DecisionClass {
  for (const cls of DECISION_CLASSES) {
    if (cls !== "interface" && !isQuantitative(cls) && linkedClasses.includes(cls)) return cls;
  }
  return linkedClasses.includes("interface") ? "interface" : "other";
}

/** One tally per class present, in DECISION_CLASSES order. A flaky scenario counts as not passed and as flaky (spec §5.8). */
export function tallyResults(results: readonly ScenarioResult[]): CategoryTally[] {
  const byClass = new Map<DecisionClass, CategoryTally>();
  for (const result of results) {
    const tally = byClass.get(result.category) ?? { category: result.category, pass: 0, total: 0, flaky: 0 };
    tally.total += 1;
    if (result.passed && !result.flaky) tally.pass += 1;
    if (result.flaky) tally.flaky += 1;
    byClass.set(result.category, tally);
  }
  return DECISION_CLASSES.flatMap((cls) => {
    const tally = byClass.get(cls);
    return tally === undefined ? [] : [tally];
  });
}

const rank = (cls: DecisionClass): number => DECISION_CLASSES.indexOf(cls);

/**
 * Spec §5.7. Every category with total < min is added into the largest category (ties: earlier in DECISION_CLASSES). If the
 * largest is itself below min, everything collapses into it. The merged category keeps the largest's name. Guarantee: when the
 * overall total >= min, every output category has total >= min. Below that the caller must not release (releaseFeedback
 * withholds with too_few_scenarios); this function does not special-case it. Does not change its input.
 */
export function mergeSmallCategories(tallies: readonly CategoryTally[], min: number = MIN_CATEGORY_SIZE): CategoryTally[] {
  let largest: CategoryTally | undefined;
  for (const t of tallies) {
    if (largest === undefined || t.total > largest.total || (t.total === largest.total && rank(t.category) < rank(largest.category))) {
      largest = t;
    }
  }
  if (largest === undefined) return [];
  const merged: CategoryTally = { ...largest };
  const kept: CategoryTally[] = [];
  for (const t of tallies) {
    if (t === largest) continue;
    if (t.total < min) {
      merged.pass += t.pass;
      merged.total += t.total;
      merged.flaky += t.flaky;
    } else {
      kept.push({ ...t });
    }
  }
  return [...kept, merged].sort((a, b) => rank(a.category) - rank(b.category));
}

/** For the evidence field `sealed.train`; counts are for people, never for the implementer. */
export interface TrainCounts {
  pass: number;
  total: number;
  flaky: number;
}

export function trainCounts(results: readonly ScenarioResult[]): TrainCounts {
  const counts: TrainCounts = { pass: 0, total: results.length, flaky: 0 };
  for (const result of results) {
    if (result.passed && !result.flaky) counts.pass += 1;
    if (result.flaky) counts.flaky += 1;
  }
  return counts;
}
