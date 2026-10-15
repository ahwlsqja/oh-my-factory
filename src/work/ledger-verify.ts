import type { StateStore } from "../adapters/state-markdown.js";
import type { LedgerEvent } from "../core/ledger.js";
import type { RepairTarget, WorkItem, WorkItemFront, WorkState } from "./types.js";
import { W_EVENT_TYPES, classifyWEvent, targetOf } from "./w-events.js";

export type ItemMismatch =
  | "no_created_event"
  | "state_mismatch"
  | "risk_mismatch"
  | "approval_unrecorded"
  | "veto_unrecorded"
  | "cancel_unrecorded"
  /** A W state with no matching W event, a file ahead of the ledger, any other mismatch, or any `done`. */
  | "w_event_missing"
  /** W events out of order, a W event before approval, or a malformed W event naming this item. */
  | "w_trail_invalid";

export type ItemVerdict =
  | { ok: true }
  | { ok: false; reason: ItemMismatch }
  | { ok: false; reason: "w_repairable"; repair_to: RepairTarget; source_seq: number };

const OK: ItemVerdict = { ok: true };
const fail = (reason: ItemMismatch): ItemVerdict => ({ ok: false, reason });

function text(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

const isHuman = (actor: string): boolean => /^human:\S+$/.test(actor);
const isWType = (type: string): boolean => (W_EVENT_TYPES as readonly string[]).includes(type);

/**
 * Checks that item.md says only what the ledger can account for (spec §6.2: no silent approval).
 * item.md is a projection; a person editing it by hand must not be able to approve, un-veto, downgrade
 * the risk of an item or move it into a W state:
 *
 * - `work.created` must exist; `risk.class` must equal its `risk_class`.
 * - `vetoed` needs a `work.vetoed` by a human; `cancelled` needs a `work.cancelled`.
 * - `awaiting_approval` needs a created state of `awaiting_approval`, no recorded veto or cancel and no W
 *   event. A recorded human approval is allowed here: `omf work approve` appends its event before it
 *   rewrites item.md, and a crash between the two must leave an item the person can approve again.
 * - every other state needs a created state of `ready` or a human `work.approved`, and no recorded veto or
 *   cancel (a vetoed item cannot be hand-edited open).
 * - the W clauses (M3b1-D4): the item's `omf` W events are folded in ledger order from the created state
 *   (`awaiting_approval` moves to `ready` at the human approval). Each step must be legal: started from
 *   ready, submitted and failed from in_progress, parked from ready or in_progress, resumed from
 *   in_progress, repaired and claim_reclaimed change nothing (claim_reclaimed is skipped before the approval check and is not counted in the trail length). Anything else is `w_trail_invalid`.
 *   The ledger state L is the last started/submitted/failed target, else `ready`. The file must equal L.
 *   A file exactly one W edge behind (the predecessor the fold recorded for the last target event) is
 *   `w_repairable`: the event was appended and the crash came before the file write. Every other mismatch,
 *   a file ahead included, is `w_event_missing`, and so is any `done` (no writer exists before M4). The
 *   predecessor comes from the fold, never from TRANSITIONS, so a hand edit is never healed.
 *
 * Events with a non-human actor where a human is required do not count, and W events by anyone but `omf`
 * are ignored. W events after a veto or cancel are ignored too (a veto can win the file race). Events of
 * other items are ignored.
 */
export function verifyItemAgainstLedger(front: WorkItemFront, events: readonly LedgerEvent[]): ItemVerdict {
  let created: { state: string; risk: string } | null = null;
  let approved = false;
  let vetoed = false;
  let cancelled = false;
  let fold: WorkState = "ready";
  let trailLength = 0;
  let trailBad = false;
  let last: { from: WorkState; to: RepairTarget; seq: number } | null = null;
  for (const event of events) {
    if (text(event.payload, "work_id") !== front.work_id || text(event.payload, "goal_id") !== front.goal_id) continue;
    if (event.type === "work.created") {
      const state = text(event.payload, "state");
      const risk = text(event.payload, "risk_class");
      if (
        created === null &&
        (state === "ready" || state === "awaiting_approval") &&
        (risk === "normal" || risk === "high")
      ) {
        created = { state, risk };
        fold = state;
      }
    } else if (created !== null && event.type === "work.approved") {
      if (isHuman(event.actor)) {
        approved = true;
        if (fold === "awaiting_approval") fold = "ready";
      }
    } else if (created !== null && event.type === "work.vetoed") {
      if (isHuman(event.actor)) vetoed = true;
    } else if (created !== null && event.type === "work.cancelled") {
      if (event.actor === "omf" || isHuman(event.actor)) cancelled = true;
    } else if (created !== null && !vetoed && !cancelled && isWType(event.type)) {
      const classified = classifyWEvent(event);
      if (classified.kind === "none") continue;
      // A reclaim is a trace of a killed run and changes nothing, in every state, awaiting_approval included:
      // beginRun records it before it refuses an unapproved high-risk item, and that must not poison the item.
      if (classified.kind !== "invalid" && classified.event.type === "work.claim_reclaimed") continue;
      trailLength += 1;
      if (classified.kind === "invalid" || fold === "awaiting_approval") {
        trailBad = true;
        continue;
      }
      const type = classified.event.type;
      const to = targetOf(type);
      if (to !== null) {
        const from: WorkState = type === "work.started" ? "ready" : "in_progress";
        if (fold !== from) trailBad = true;
        else {
          last = { from, to: to as RepairTarget, seq: classified.seq };
          fold = to;
        }
      } else if (
        type === "work.parked"
          ? fold !== "ready" && fold !== "in_progress"
          : type === "work.resumed" && fold !== "in_progress"
      ) {
        trailBad = true;
      }
    }
  }
  if (created === null) return fail("no_created_event");
  if (front.risk.class !== created.risk) return fail("risk_mismatch");
  switch (front.state) {
    case "vetoed":
      return vetoed ? OK : fail("veto_unrecorded");
    case "cancelled":
      return cancelled ? OK : fail("cancel_unrecorded");
    case "awaiting_approval":
      if (created.state !== "awaiting_approval" || vetoed || cancelled) return fail("state_mismatch");
      return trailLength > 0 ? fail("w_trail_invalid") : OK;
    default: {
      if (vetoed || cancelled) return fail("state_mismatch");
      if (created.state === "awaiting_approval" && !approved) return fail("approval_unrecorded");
      if (trailBad) return fail("w_trail_invalid");
      if (front.state === "done") return fail("w_event_missing");
      const ledgerState: WorkState = last === null ? "ready" : last.to;
      if (front.state === ledgerState) return OK;
      if (last !== null && front.state === last.from) {
        return { ok: false, reason: "w_repairable", repair_to: last.to, source_seq: last.seq };
      }
      return fail("w_event_missing");
    }
  }
}

/** The part of an `ItemVerdict` that names the W edge a repair would apply. */
type RepairVerdict = Extract<ItemVerdict, { reason: "w_repairable" }>;

export interface VerifiedItems {
  items: WorkItem[];
  malformed: { work_id: string | null; dir: string; reason: string }[];
  /**
   * The subset of `malformed` whose file is exactly one W edge behind the ledger (reason `w_repairable`). They
   * stay in `malformed` so every existing consumer still excludes them; the tick, reconcile and `goal status`
   * read this list to count them (M3b1-D5): by `repair_to` for STOP_IF, by `file_state` for the WIP cap.
   */
  repairable: {
    work_id: string;
    dir: string;
    file_state: WorkItemFront["state"];
    repair_to: RepairVerdict["repair_to"];
  }[];
}

/**
 * The goal's items that the ledger accounts for, plus every item that is not: unreadable files from the
 * store and ledger mismatches from verifyItemAgainstLedger. The tick, reconcile (open and WIP counts),
 * M3 dispatch and `omf work list` read items through this, so a malformed item is never ready and never
 * counted as open work (D27).
 */
export function verifiedItems(store: StateStore, events: readonly LedgerEvent[], goalId: string): VerifiedItems {
  const items: WorkItem[] = [];
  const malformed: VerifiedItems["malformed"] = store.malformedItems(goalId).map((entry) => ({ ...entry }));
  const repairable: VerifiedItems["repairable"] = [];
  for (const item of store.fetchAllWorkItems(goalId)) {
    const verdict = verifyItemAgainstLedger(item.front, events);
    if (verdict.ok) items.push(item);
    else {
      malformed.push({ work_id: item.front.work_id, dir: item.dir, reason: verdict.reason });
      if (verdict.reason === "w_repairable") {
        repairable.push({
          work_id: item.front.work_id,
          dir: item.dir,
          file_state: item.front.state,
          repair_to: verdict.repair_to,
        });
      }
    }
  }
  const byDir = (a: { dir: string }, b: { dir: string }): number => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0);
  malformed.sort(byDir);
  repairable.sort(byDir);
  return { items, malformed, repairable };
}
