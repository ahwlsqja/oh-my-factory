import { workItemDir } from "../../src/adapters/state-markdown.js";
import { type ItemVerdict, verifyItemAgainstLedger } from "../../src/work/ledger-verify.js";
import type { OutcomeInput, OutcomeRow } from "../../src/work/outcome.js";
import type { WorkState } from "../../src/work/types.js";
import { W_EVENT_TYPES, newRunId, wEvent } from "../../src/work/w-events.js";
import { WError } from "../../src/work/w-verbs.js";
import { type FinishResult, type WRun, beginRun } from "../../src/work/w-run.js";
import { TICK_GOAL, type TickFixture, ledgerEvents } from "./tick.js";

/** A run on `workId` with the fixture clock. It uses the default store, as production does. */
export function begin(fx: TickFixture, workId: string): WRun {
  return beginRun({ location: fx.location, workId, now: fx.clock.now });
}

/**
 * The input M3b2's classifier will produce for a table row. Only the closed reason codes matter here: one per
 * row, none for `success`.
 */
export function inputFor(row: OutcomeRow): OutcomeInput {
  switch (row.outcome) {
    case "success":
      return { outcome: "success", exhausted: false, reason_code: null };
    case "flawed":
      return { outcome: "flawed", exhausted: row.exhausted, reason_code: "station_error" };
    case "blocked":
      return {
        outcome: "blocked",
        exhausted: row.exhausted,
        reason_code: row.exhausted ? "budget_exhausted" : "gate_blocked",
      };
    case "manual":
      return { outcome: "manual", exhausted: false, reason_code: "manual_required" };
  }
}

/** A whole run: begin, start, finish. `finish` releases the claim. */
export function runWhole(fx: TickFixture, workId: string, input: OutcomeInput): FinishResult {
  const run = begin(fx, workId);
  run.start();
  return run.finish(input);
}

/** Starts the item and lets go of the claim without finishing, the way a run that ended early would. */
export function startOnly(fx: TickFixture, workId: string): void {
  const run = begin(fx, workId);
  run.start();
  run.abandon();
}

/**
 * Simulates a crash between the ledger append and the file write (D27: the event comes first): appends the
 * event of one W edge and leaves item.md alone. Returns the event's seq. `submitted` and `failed` need the item
 * to be started already (`startOnly`).
 */
export function crashAfter(fx: TickFixture, workId: string, edge: "started" | "submitted" | "failed"): number {
  const scope = { goal_id: TICK_GOAL, work_id: workId, run_id: newRunId(fx.clock.now(), () => "0000") };
  const event =
    edge === "started"
      ? wEvent({ type: "work.started", payload: { ...scope, from: "ready" } })
      : edge === "submitted"
        ? wEvent({
            type: "work.submitted",
            payload: { ...scope, outcome: "success", recommendation: "merge_recommended" },
          })
        : wEvent({ type: "work.failed", payload: { ...scope, outcome: "flawed", reason_code: "station_error" } });
  return fx.ledger.append(event).seq;
}

/** The item's W-side events in ledger order. */
export function wTrail(
  fx: TickFixture,
  workId: string,
): { seq: number; type: string; payload: Record<string, unknown> }[] {
  return ledgerEvents(fx)
    .filter((event) => (W_EVENT_TYPES as readonly string[]).includes(event.type) && event.payload.work_id === workId)
    .map(({ seq, type, payload }) => ({ seq, type, payload }));
}

export function stateOf(fx: TickFixture, workId: string): WorkState {
  const [item] = fx.store.fetchWorkItemsByIds([workId]);
  if (item === undefined) throw new Error(`no work item ${workId}`);
  return item.front.state;
}

export function verdictOf(fx: TickFixture, workId: string): ItemVerdict {
  const [item] = fx.store.fetchWorkItemsByIds([workId]);
  if (item === undefined) throw new Error(`no work item ${workId}`);
  return verifyItemAgainstLedger(item.front, ledgerEvents(fx));
}

export function itemDirOf(fx: TickFixture, workId: string): string {
  return workItemDir(fx.location.dir, TICK_GOAL, workId);
}

/** The code of the `WError` that `act` throws; fails the test if it throws anything else or nothing. */
export function wCode(act: () => unknown): string {
  try {
    act();
  } catch (err) {
    if (err instanceof WError) return err.code;
    throw err;
  }
  throw new Error("expected a WError, nothing was thrown");
}
