import type { StateStore } from "../adapters/state-markdown.js";
import type { LedgerEvent } from "../core/ledger.js";
import type { WorkItem, WorkItemFront } from "./types.js";

export type ItemVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: "no_created_event" | "state_mismatch" | "risk_mismatch" | "approval_unrecorded" | "veto_unrecorded" | "cancel_unrecorded";
    };

const OK: ItemVerdict = { ok: true };
const fail = (reason: Exclude<ItemVerdict, { ok: true }>["reason"]): ItemVerdict => ({ ok: false, reason });

function text(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

const isHuman = (actor: string): boolean => /^human:\S+$/.test(actor);

/**
 * Checks that item.md says only what the ledger can account for (spec §6.2: no silent approval).
 * item.md is a projection; a person editing it by hand must not be able to approve, un-veto or
 * downgrade the risk of an item:
 *
 * - `work.created` must exist; `risk.class` must equal its `risk_class`.
 * - `vetoed` needs a `work.vetoed` by a human; `cancelled` needs a `work.cancelled`.
 * - `awaiting_approval` needs a created state of `awaiting_approval` and no recorded veto or cancel. A
 *   recorded human approval is allowed here: `omf work approve` appends its event before it rewrites
 *   item.md, and a crash between the two must leave an item the person can approve again.
 * - every other state (ready, and the W states M3 adds) needs a created state of `ready` or a
 *   human `work.approved`, and no recorded veto or cancel (a vetoed item cannot be hand-edited open).
 *
 * Events with a non-human actor where a human is required do not count. Events of other items are ignored.
 */
export function verifyItemAgainstLedger(front: WorkItemFront, events: readonly LedgerEvent[]): ItemVerdict {
  let created: { state: string; risk: string } | null = null;
  let approved = false;
  let vetoed = false;
  let cancelled = false;
  for (const event of events) {
    if (text(event.payload, "work_id") !== front.work_id || text(event.payload, "goal_id") !== front.goal_id) continue;
    if (event.type === "work.created") {
      const state = text(event.payload, "state");
      const risk = text(event.payload, "risk_class");
      if (created === null && (state === "ready" || state === "awaiting_approval") && (risk === "normal" || risk === "high")) {
        created = { state, risk };
      }
    } else if (created !== null && event.type === "work.approved") {
      if (isHuman(event.actor)) approved = true;
    } else if (created !== null && event.type === "work.vetoed") {
      if (isHuman(event.actor)) vetoed = true;
    } else if (created !== null && event.type === "work.cancelled") {
      if (event.actor === "omf" || isHuman(event.actor)) cancelled = true;
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
      return created.state === "awaiting_approval" && !vetoed && !cancelled ? OK : fail("state_mismatch");
    default:
      if (vetoed || cancelled) return fail("state_mismatch");
      return created.state === "awaiting_approval" && !approved ? fail("approval_unrecorded") : OK;
  }
}

export interface VerifiedItems {
  items: WorkItem[];
  malformed: { work_id: string | null; dir: string; reason: string }[];
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
  for (const item of store.fetchAllWorkItems(goalId)) {
    const verdict = verifyItemAgainstLedger(item.front, events);
    if (verdict.ok) items.push(item);
    else malformed.push({ work_id: item.front.work_id, dir: item.dir, reason: verdict.reason });
  }
  malformed.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  return { items, malformed };
}
