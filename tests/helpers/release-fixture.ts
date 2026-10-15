import { budgetState, declareBudget } from "../../src/core/budget.js";
import { Ledger, type LedgerEvent } from "../../src/core/ledger.js";
import type { DecisionClass } from "../../src/decision/types.js";
import type { ReleaseInput } from "../../src/feedback/release.js";
import type { ScenarioResult } from "../../src/feedback/types.js";
import { makeTempDir } from "./tmp.js";

export const GOAL = "g-checkout";
export const WORK = "w-0123456789ab";
export const RUN = "r-20261014T091500Z-0001";
export const DIGEST = "a".repeat(64);

/** `{ interface: [3, 5] }` is five train scenarios in that category, three of them passed (none flaky). */
export function counts(
  parts: Partial<Record<DecisionClass, readonly [pass: number, total: number]>>,
): ScenarioResult[] {
  const out: ScenarioResult[] = [];
  for (const [category, pair] of Object.entries(parts) as [DecisionClass, readonly [number, number]][]) {
    for (let i = 0; i < pair[1]; i += 1) out.push({ category, passed: i < pair[0], flaky: false });
  }
  return out;
}

/** A fresh ledger; with a number, a person has declared that `disclosure` budget for GOAL. */
export function declaredLedger(disclosure: number | null): Ledger {
  const ledger = new Ledger(makeTempDir("omf-release-"));
  if (disclosure !== null) declareBudget(ledger, GOAL, "disclosure", disclosure, "human:dev");
  return ledger;
}

export function releaseInput(results: readonly ScenarioResult[], extra: Partial<ReleaseInput> = {}): ReleaseInput {
  return { goalId: GOAL, workId: WORK, runId: RUN, trainDigest: DIGEST, results, ...extra };
}

export function eventsOf(ledger: Ledger, type: string): LedgerEvent[] {
  return ledger.readVerified().filter((event) => event.type === type);
}

/** Disclosure units left for `goalId`, read from a fresh fold of the ledger. */
export function remaining(ledger: Ledger, goalId = GOAL): number | undefined {
  return budgetState(ledger, goalId, "disclosure")?.remaining;
}
