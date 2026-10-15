import type { NewEvent } from "../core/ledger.js";
import { validate } from "../core/schema.js";
import type { GateRunResult } from "./run-gates.js";

/** The three ids every gate, audit and isolation event carries (structural: this file takes no dependency on the audit module). */
interface EventScope {
  goal_id: string;
  work_id: string;
  run_id: string;
}

/**
 * The `gates.evaluated` event as OMF appends it (actor `omf`). The payload is the line OMF composed plus the closed
 * verdict fields: no command output, path or gate name outside the closed list can enter. It is checked against the
 * schema first, so an invalid line fails here, at the writer, instead of becoming a ledger event.
 */
export function gatesEvaluatedEvent(scope: EventScope, result: GateRunResult): NewEvent {
  const { verdict } = result;
  const payload: Record<string, unknown> = {
    ...scope,
    line: result.line,
    status: verdict.status,
    failing: [...verdict.failing],
    misconfigured: [...verdict.misconfigured],
    reasons: [...verdict.reasons],
  };
  const check = validate("gate-event.schema.json", { type: "gates.evaluated", payload });
  if (!check.ok) throw new Error(`invalid gates.evaluated event: ${check.errors}`);
  return { actor: "omf", type: "gates.evaluated", payload };
}
