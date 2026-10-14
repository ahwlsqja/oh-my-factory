import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { claimFile, claimStatus } from "../../src/work/claim.js";
import { OUTCOME_ROWS } from "../../src/work/outcome.js";
import { canTransition } from "../../src/work/transitions.js";
import type { WorkState } from "../../src/work/types.js";
import { verifiedItems } from "../../src/work/ledger-verify.js";
import { TICK_GOAL, ledgerEvents, seedWorkItem, setupTick } from "../helpers/tick.js";
import { begin, inputFor, itemDirOf, runWhole, stateOf, verdictOf, wCode, wTrail } from "../helpers/w-flow.js";

// Spec §5.6 and M3-D19: the outcome of a run decides what happens to the item, and that decision is a
// table in code, not a judgment made at each call site. Every row below is walked with a real item, a
// real claim and the real ledger. The table moves an item along edges the transition table already has;
// `tests/work/transitions.test.ts` pins that table, so a new edge would fail there first.
const NAMED = OUTCOME_ROWS.map((row) => ({ name: `${row.outcome}${row.exhausted ? " (exhausted)" : ""}`, row }));

describe("W-outcome-state-table", () => {
  it.each(NAMED)("$name ends in the state, event and claim the table names", ({ row }) => {
    const fx = setupTick();
    const workId = seedWorkItem(fx, { title: `Table walk ${row.outcome}${row.exhausted ? " exhausted" : ""}` });
    const input = inputFor(row);

    const result = runWhole(fx, workId, input);

    if (!result.applied) throw new Error(`finish was refused: ${result.reason}`);
    expect(result.disposition).toEqual(row.disposition);

    // State: submit and fail move the item; park leaves it where the run started it.
    const finalState = row.disposition.item_state === "unchanged" ? "in_progress" : row.disposition.item_state;
    expect(stateOf(fx, workId)).toBe(finalState);
    const path: WorkState[] = ["ready", "in_progress", ...(finalState === "in_progress" ? [] : [finalState])];
    path.slice(1).forEach((to, index) => {
      const from = path[index] as WorkState;
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
    });

    // Event: exactly started, then the one event of the row, with the row's payload.
    const lastType = { submit: "work.submitted", fail: "work.failed", park: "work.parked" }[row.disposition.action];
    const trail = wTrail(fx, workId);
    expect(trail.map((event) => event.type)).toEqual(["work.started", lastType]);
    const payload: Record<string, unknown> = trail[1]?.payload ?? {};
    expect(payload).toMatchObject({ goal_id: TICK_GOAL, work_id: workId, outcome: row.outcome });
    if (row.disposition.action === "submit") {
      expect(payload.recommendation).toBe(row.disposition.recommendation);
      expect("reason_code" in payload).toBe(false);
    } else {
      expect(payload.reason_code).toBe(input.reason_code);
    }

    // Claim: released by every row.
    const dir = itemDirOf(fx, workId);
    expect(claimStatus(dir).held).toBe(false);
    expect(existsSync(claimFile(dir))).toBe(false);

    // STOP_IF: only a submit adds to the unreviewed pile, and the item still verifies.
    const awaiting = verifiedItems(fx.store, ledgerEvents(fx), TICK_GOAL).items.filter(
      (item) => item.front.state === "awaiting_review",
    );
    expect(awaiting.length).toBe(row.disposition.counts_toward_stop_if ? 1 : 0);
    expect(verdictOf(fx, workId)).toEqual({ ok: true });
  });

  it("a manual park refuses the next run with needs_human; a blocked park does not (M3b1-D7)", () => {
    const fx = setupTick();
    const manual = seedWorkItem(fx, { title: "Manual park" });
    runWhole(fx, manual, { outcome: "manual", exhausted: false, reason_code: "manual_required" });

    expect(wCode(() => begin(fx, manual))).toBe("needs_human");
    expect(claimStatus(itemDirOf(fx, manual)).held).toBe(false);
    expect(stateOf(fx, manual)).toBe("in_progress");

    const blocked = seedWorkItem(fx, { title: "Blocked park" });
    runWhole(fx, blocked, { outcome: "blocked", exhausted: false, reason_code: "gate_blocked" });
    const again = begin(fx, blocked);
    expect(again.resumed).toBe(true);
    again.abandon();
  });
});
