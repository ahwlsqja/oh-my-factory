export type DecisionErrorCode =
  | "not_human" | "unknown_decision" | "duplicate_id" | "already_closed" | "invalid_input" | "leak"
  | "interface_required" | "interface_not_closable" | "deferral_in_past" | "goal_not_locked";

/**
 * A refusal the decision verbs can name. The CLI maps it to exit 1 with its message; any other thrown error stays
 * exit 2 (the command could not run). Lives here, not in write.ts, so the leak lint can throw it without a cycle.
 */
export class DecisionError extends Error {
  constructor(
    readonly code: DecisionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DecisionError";
  }
}
