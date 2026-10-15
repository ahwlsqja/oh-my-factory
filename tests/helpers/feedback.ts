import { DECISION_CLASSES, isQuantitative } from "../../src/decision/types.js";
import type { DecisionClass } from "../../src/decision/types.js";
import type { ScenarioResult } from "../../src/feedback/types.js";

/** Classes a CLI scenario can link in v0.1: everything but the quantitative ones (M3-D17). */
export const LINKABLE_CLASSES: readonly DecisionClass[] = DECISION_CLASSES.filter((cls) => !isQuantitative(cls));

/**
 * mulberry32: a small seeded PRNG, so a property loop is the same on every machine and a failure can be replayed
 * from its seed. No fast-check in this repository (M3d keeps no new dependency).
 */
export function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error("pick from an empty list");
  return item;
}

/** `pass` passed, `fail` failed (not flaky) and `flaky` flaky scenarios of one category. */
export function scenarios(category: DecisionClass, pass: number, fail: number, flaky = 0): ScenarioResult[] {
  return [
    ...Array.from({ length: pass }, (): ScenarioResult => ({ category, passed: true, flaky: false })),
    ...Array.from({ length: fail }, (): ScenarioResult => ({ category, passed: false, flaky: false })),
    ...Array.from({ length: flaky }, (): ScenarioResult => ({ category, passed: false, flaky: true })),
  ];
}

/** `total` scenarios over the linkable classes, about 15% flaky and 60% of the rest passed. */
export function randomResults(rng: () => number, total: number): ScenarioResult[] {
  return Array.from({ length: total }, (): ScenarioResult => {
    const flaky = rng() < 0.15;
    return { category: pick(rng, LINKABLE_CLASSES), passed: !flaky && rng() < 0.6, flaky };
  });
}
