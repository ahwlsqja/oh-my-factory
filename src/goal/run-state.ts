import type { LedgerEvent } from "../core/ledger.js";

/**
 * The four termination states belong to the goal RUN, not to every tick. `blocked_on_user` and `failed`
 * wait for a person (J6 continue); `finish` and `cancelled` are final.
 */
export type Termination = "finish" | "blocked_on_user" | "failed" | "cancelled";

/** The judgment point a block waits on (spec §6): J1 goal definition, J6 loop guard, J8 budget. */
export type JCode = "J1" | "J6" | "J8";

export interface Escalation {
  tick_id: string;
  j: JCode;
  reason_code: string;
  signature: string | null;
  question: string;
  options: string[];
  default: string;
  at: string;
}

export interface RunState {
  status: "running" | Termination;
  /** When the current status began; null for a goal that never left `running`. */
  since: string | null;
  reason_code: string | null;
  /** The latest goal.escalated not yet cleared per the §5.1 table. */
  open_escalation: Escalation | null;
  ticks: number;
}

const TERMINATIONS: readonly string[] = ["finish", "blocked_on_user", "failed", "cancelled"];
const J_CODES: readonly string[] = ["J1", "J6", "J8"];

function invalid(event: LedgerEvent, why: string): Error {
  return new Error(`invalid ${event.type} event at seq ${event.seq}: ${why}`);
}

function requireHuman(event: LedgerEvent): void {
  if (!event.actor.startsWith("human:")) throw invalid(event, `${event.type} by ${event.actor}`);
}

function escalationOf(event: LedgerEvent): Escalation {
  const { tick_id, j, reason_code, signature, question, options, default: fallback } = event.payload;
  if (
    typeof tick_id !== "string" ||
    typeof j !== "string" ||
    !J_CODES.includes(j) ||
    typeof reason_code !== "string" ||
    (signature !== null && typeof signature !== "string") ||
    typeof question !== "string" ||
    !Array.isArray(options) ||
    !options.every((option) => typeof option === "string") ||
    typeof fallback !== "string"
  ) {
    throw invalid(event, "malformed payload");
  }
  return {
    tick_id,
    j: j as JCode,
    reason_code,
    signature: signature as string | null,
    question,
    options: options as string[],
    default: fallback,
    at: event.ts,
  };
}

function terminationOf(event: LedgerEvent): { state: Termination; reason_code: string } {
  const { tick_id, state, reason_code } = event.payload;
  if (
    (tick_id !== null && typeof tick_id !== "string") ||
    typeof state !== "string" ||
    !TERMINATIONS.includes(state) ||
    typeof reason_code !== "string"
  ) {
    throw invalid(event, "malformed payload");
  }
  return { state: state as Termination, reason_code };
}

/** `finish` and `cancelled` end a goal run for good. */
export function isFinal(status: RunState["status"]): boolean {
  return status === "finish" || status === "cancelled";
}

/**
 * The goal's run state, applying the §5.1 transition table to the verified ledger (spec §4.4):
 * - goal.escalated blocks the goal; a goal.escalated with no following goal.terminated still projects as
 *   blocked_on_user, because escalate appends two non-atomic events and a crash between them must not leave
 *   the goal running;
 * - goal.terminated sets its state (cancelled must come from a person); finish and cancelled are final;
 * - goal.resumed (a person) clears blocked_on_user and failed;
 * - goal.approved (a person) clears the escalation and the block only when the open escalation is J1;
 *   for J6 and J8 it changes nothing, so a resume is still required;
 * - budget raises and goal.wall_time_raised have no effect on the status.
 * An event written outside these rules (wrong actor, malformed payload) stops the line instead of being skipped.
 */
export function runStateFromEvents(events: readonly LedgerEvent[], goalId: string): RunState {
  const run: RunState = { status: "running", since: null, reason_code: null, open_escalation: null, ticks: 0 };
  const reopen = (at: string): void => {
    run.status = "running";
    run.since = at;
    run.reason_code = null;
    run.open_escalation = null;
  };
  for (const event of events) {
    if (event.payload.goal_id !== goalId) continue;
    switch (event.type) {
      case "goal.tick_started":
        run.ticks += 1;
        break;
      case "goal.escalated": {
        const escalation = escalationOf(event);
        if (isFinal(run.status)) break;
        run.open_escalation = escalation;
        run.status = "blocked_on_user";
        run.since = event.ts;
        run.reason_code = escalation.reason_code;
        break;
      }
      case "goal.terminated": {
        const ended = terminationOf(event);
        if (ended.state === "cancelled") requireHuman(event);
        if (isFinal(run.status)) break;
        run.status = ended.state;
        run.since = event.ts;
        run.reason_code = ended.reason_code;
        break;
      }
      case "goal.resumed":
        requireHuman(event);
        if (run.status === "blocked_on_user" || run.status === "failed") reopen(event.ts);
        break;
      case "goal.approved":
        requireHuman(event);
        if (run.status === "blocked_on_user" && run.open_escalation?.j === "J1") reopen(event.ts);
        break;
      default:
        break;
    }
  }
  return run;
}
