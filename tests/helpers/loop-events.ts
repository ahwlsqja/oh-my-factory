import type { Ledger, LedgerEvent } from "../../src/core/ledger.js";

/** Appends one goal event. `payload` is merged over `{ goal_id }`. Used to build ledgers without running a tick. */
export function appendGoalEvent(
  ledger: Ledger,
  type: string,
  goalId: string,
  actor = "omf",
  payload: Record<string, unknown> = {},
): LedgerEvent {
  return ledger.append({ actor, type, payload: { goal_id: goalId, ...payload } });
}

/** A `goal.tick_ended` event with the full spec §6 payload; only the fields a test cares about are parameters. */
export function appendTickEnded(
  ledger: Ledger,
  goalId: string,
  fields: { signatures?: string[]; progress_sig?: string | null; reconciled?: boolean } = {},
): LedgerEvent {
  const reconciled = fields.reconciled ?? false;
  return appendGoalEvent(ledger, "goal.tick_ended", goalId, "omf", {
    tick_id: `t-test-${ledger.readVerified().length + 1}`,
    status: "continue",
    outcome: "stopped",
    reason_code: null,
    progress_sig: fields.progress_sig ?? null,
    signatures: fields.signatures ?? [],
    stage_ms: {},
    model_calls: reconciled ? 1 : 0,
    reconciled,
    created: 0,
    rounds_remaining: null,
    report: null,
  });
}

/** `goal.escalated`, then (unless told not to) `goal.terminated(blocked_on_user)`, exactly as `escalate` writes them. */
export function appendEscalation(
  ledger: Ledger,
  goalId: string,
  j: "J1" | "J6" | "J8",
  reasonCode: string,
  options: { terminate?: boolean } = {},
): void {
  appendGoalEvent(ledger, "goal.escalated", goalId, "omf", {
    tick_id: "t-test",
    j,
    reason_code: reasonCode,
    signature: null,
    question: "question?",
    options: ["a", "b"],
    default: "stay stopped",
  });
  if (options.terminate !== false) {
    appendGoalEvent(ledger, "goal.terminated", goalId, "omf", {
      tick_id: "t-test",
      state: "blocked_on_user",
      reason_code: reasonCode,
    });
  }
}
