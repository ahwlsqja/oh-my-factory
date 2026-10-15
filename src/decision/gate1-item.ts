import type { LedgerEvent } from "../core/ledger.js";
import type { ProjectLocation } from "../core/paths.js";
import type { WorkItem } from "../work/types.js";
import { type Gate1Result, evaluateGate1, intentQuestionIds } from "./gate1.js";
import { loadLeakContext } from "./leak-lint.js";
import { foldDecisions } from "./state.js";
import type { DecisionScope } from "./types.js";

/**
 * GATE-1 for one work item over events the caller already verified (spec §5.2). It makes the same four calls as
 * `snapshotOf` in `cli/decide.ts` (`loadLeakContext`, `foldDecisions`, `intentQuestionIds`, `evaluateGate1`) but
 * imports nothing from the CLI, so the station line can use it without pulling in commander. A goal with no lock
 * throws `DecisionError("goal_not_locked")` from `loadLeakContext`: the caller turns a throw into `not_run`, never
 * into a pass.
 */
export function gate1ForItem(
  location: ProjectLocation,
  item: WorkItem,
  events: readonly LedgerEvent[],
  now: Date,
): { scope: DecisionScope; result: Gate1Result } {
  const scope: DecisionScope = { goal_id: item.front.goal_id, work_id: item.front.work_id };
  const leak = loadLeakContext(location.dir, scope.goal_id, events);
  const state = foldDecisions(events, scope);
  const questionIds = intentQuestionIds(item.intent.candidate.open_questions.length);
  return { scope, result: evaluateGate1(state, now, { leak, intentQuestionIds: questionIds }) };
}
