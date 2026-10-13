import type { StateStore } from "../adapters/state-markdown.js";
import type { Ledger, LedgerEvent } from "../core/ledger.js";
import { OPEN_STATES } from "../work/types.js";
import { type Escalation, type JCode, type RunState, type Termination, isFinal, runStateFromEvents } from "./run-state.js";

/**
 * What each stop asks of a person (spec §6, D10). The default is always `stay stopped`: a stopped goal
 * refuses ticks until a person acts (J6). Questions are fixed text so nothing from a model or a metric
 * can reach the ledger through them.
 */
export const ESCALATIONS: Readonly<Record<string, { j: JCode; question: string; options: string[]; default: string }>> = {
  goal_not_approved: {
    j: "J1",
    question: "The goal has no approval yet. Review its metrics and approve it?",
    options: ["approve the goal", "stay stopped"],
    default: "stay stopped",
  },
  reapproval_required: {
    j: "J1",
    question: "The goal, a locked metric or a watched path changed since the approval. Approve the new version?",
    options: ["re-approve the goal", "revert the change", "stay stopped"],
    default: "stay stopped",
  },
  stale_goal: {
    j: "J1",
    question: "The goal looks stale (its age, the commits since, or the target moving away). Re-approve it as it is?",
    options: ["re-approve the goal", "change the goal, then re-approve", "stay stopped"],
    default: "stay stopped",
  },
  approach_unusable: {
    j: "J1",
    question: "The objective or the approach text holds a number or a metric name, so it cannot be shown to the model. Fix the text?",
    options: ["edit goal.md, then resume", "stay stopped"],
    default: "stay stopped",
  },
  wall_time_exceeded: {
    j: "J8",
    question: "The wall-time budget is used up. Raise it?",
    options: ["raise the wall time, then resume", "stay stopped"],
    default: "stay stopped",
  },
  rounds_exhausted: {
    j: "J8",
    question: "The rounds budget is used up. Raise it?",
    options: ["raise the rounds, then resume", "stay stopped"],
    default: "stay stopped",
  },
  disclosure_exhausted: {
    j: "J8",
    question: "The disclosure budget is used up. Raise it?",
    options: ["raise the disclosure budget, then resume", "stay stopped"],
    default: "stay stopped",
  },
  no_progress: {
    j: "J6",
    question: "The last model answer changed nothing that can be observed. Decide on the open work items and continue, or stop?",
    options: ["decide on the open items, then resume", "cancel the goal", "stay stopped"],
    default: "stay stopped",
  },
  repeated_signature: {
    j: "J6",
    question: "The same outcome repeated three times. Fix the cause and continue, or stop?",
    options: ["fix the cause, then resume", "cancel the goal", "stay stopped"],
    default: "stay stopped",
  },
};

/**
 * Stops the goal for a person: goal.escalated, then goal.terminated(blocked_on_user). The two appends are not
 * atomic; runStateFromEvents treats an escalation with no termination as blocked, so a crash between them
 * cannot leave the goal running.
 */
export function escalate(
  ledger: Ledger,
  goalId: string,
  tickId: string,
  reasonCode: keyof typeof ESCALATIONS,
  signature: string | null,
): Escalation {
  const entry = ESCALATIONS[reasonCode];
  if (entry === undefined) throw new Error(`unknown escalation reason code ${reasonCode}`);
  const event = ledger.append({
    actor: "omf",
    type: "goal.escalated",
    payload: {
      goal_id: goalId,
      tick_id: tickId,
      j: entry.j,
      reason_code: reasonCode,
      signature,
      question: entry.question,
      options: [...entry.options],
      default: entry.default,
    },
  });
  terminate(ledger, goalId, "blocked_on_user", tickId, reasonCode);
  return {
    tick_id: tickId,
    j: entry.j,
    reason_code: reasonCode,
    signature,
    question: entry.question,
    options: [...entry.options],
    default: entry.default,
    at: event.ts,
  };
}

/** Records a termination of the goal run (spec §4.4). `cancelled` must carry a person as actor (runStateFromEvents checks). */
export function terminate(
  ledger: Ledger,
  goalId: string,
  state: Termination,
  tickId: string | null,
  reasonCode: string,
  actor = "omf",
): LedgerEvent {
  return ledger.append({
    actor,
    type: "goal.terminated",
    payload: { goal_id: goalId, tick_id: tickId, state, reason_code: reasonCode },
  });
}

/** Why a goal in this state cannot be resumed, or null. Shared by resumeGoal and the CLI, which asks before it prompts. */
export function resumeProblem(state: RunState, goalId: string): string | null {
  if (state.status === "blocked_on_user" || state.status === "failed") return null;
  return `goal ${goalId} is ${state.status}; only a blocked_on_user or failed goal can be resumed`;
}

/** Why a goal in this state cannot be cancelled, or null. */
export function cancelProblem(state: RunState, goalId: string): string | null {
  return isFinal(state.status) ? `goal ${goalId} is already ${state.status}; nothing to cancel` : null;
}

/**
 * J6 continue: a person lets a blocked or failed goal tick again. The check and the append share the ledger
 * lock, so two resumes cannot both pass. Signature counts restart after this event (signatures.ts).
 */
export function resumeGoal(ledger: Ledger, goalId: string, actor: string): RunState {
  if (!actor.startsWith("human:")) throw new Error(`only a person may resume a goal (J6); actor was ${actor}`);
  ledger.appendWith((events) => {
    const state = runStateFromEvents(events, goalId);
    const problem = resumeProblem(state, goalId);
    if (problem !== null) throw new Error(problem);
    return { actor, type: "goal.resumed", payload: { goal_id: goalId, from: state.status } };
  });
  return runStateFromEvents(ledger.readVerified(), goalId);
}

/**
 * J6 stop: a person ends the goal. Every open work item is cancelled, also one a W run has claimed or that is in
 * progress (the store takes the short item lock, not the claim). For each item the work.cancelled event is
 * appended BEFORE the file changes, so no item is ever cancelled on disk without its event (D27, D30); the
 * goal.terminated(cancelled) event comes last. Callers hold the tick lock (D23).
 */
export function cancelGoal(
  ledger: Ledger,
  store: StateStore,
  goalId: string,
  actor: string,
  now: Date,
): { cancelled: string[] } {
  if (!actor.startsWith("human:")) throw new Error(`only a person may cancel a goal (J6); actor was ${actor}`);
  const problem = cancelProblem(runStateFromEvents(ledger.readVerified(), goalId), goalId);
  if (problem !== null) throw new Error(problem);
  const cancelled: string[] = [];
  for (const item of store.fetchWorkItemsByStates(goalId, OPEN_STATES)) {
    const workId = item.front.work_id;
    ledger.append({
      actor,
      type: "work.cancelled",
      payload: { goal_id: goalId, work_id: workId, cause: "goal_cancelled" },
    });
    store.cancelWorkItem(workId, actor, now);
    cancelled.push(workId);
  }
  terminate(ledger, goalId, "cancelled", null, "cancelled_by_user", actor);
  return { cancelled };
}

/**
 * The exact CLI commands that lead out of an escalation (D10, §5.1). A step that starts with `omf ` is a
 * command (tests run its `--help`); other steps are prose.
 */
export function nextSteps(e: Escalation, goalId: string): string[] {
  const resume = `omf goal resume ${goalId}`;
  switch (e.reason_code) {
    case "goal_not_approved":
    case "stale_goal":
      return [`omf goal approve ${goalId}`];
    case "reapproval_required":
      return [`omf goal audit ${goalId}`, `omf goal approve ${goalId}`];
    case "approach_unusable":
      return ["edit goal.md: remove metric names and numbers from the objective and the ## Approach section", resume];
    case "wall_time_exceeded":
      return [`omf budget raise ${goalId} wall_time <dur>`, resume];
    case "rounds_exhausted":
      return [`omf budget raise ${goalId} rounds <n>`, resume];
    case "disclosure_exhausted":
      return [`omf budget raise ${goalId} disclosure <n>`, resume];
    case "no_progress":
      return [`omf work list ${goalId}`, "omf work approve <work_id>", "omf veto <work_id>", resume, `omf goal cancel ${goalId}`];
    case "repeated_signature":
      // An audit stop is repaired by approving again, which also restarts the breaker window.
      if (e.signature?.startsWith("audit|")) return [`omf goal audit ${goalId}`, `omf goal approve ${goalId}`, resume];
      return ["read the latest tick reports to see why the same outcome repeated", resume, `omf goal cancel ${goalId}`];
    default:
      throw new Error(`no next steps for ${e.reason_code}`);
  }
}

/** Next steps for a goal that does not tick: the open escalation's steps, or a fallback for failed and hand-blocked goals. */
export function stoppedNextSteps(state: RunState, goalId: string): string[] {
  if (state.open_escalation !== null) return nextSteps(state.open_escalation, goalId);
  if (state.status === "failed") {
    return ["read the latest tick report for the error", `omf goal resume ${goalId}`, `omf goal cancel ${goalId}`];
  }
  if (state.status === "blocked_on_user") return [`omf goal audit ${goalId}`, `omf goal resume ${goalId}`];
  return [];
}
