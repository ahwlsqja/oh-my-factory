import { findWorkItem } from "../adapters/state-markdown.js";
import { standingSeal } from "../author/standing.js";
import { Ledger, type LedgerEvent } from "../core/ledger.js";
import type { ProjectLocation } from "../core/paths.js";
import { safeText } from "../core/safe-text.js";
import { locationEnv } from "../vault/line-guard.js";
import { openVault } from "../vault/vault.js";
import { claimStatus } from "../work/claim.js";
import { trustedRecommendation } from "../work/evidence.js";
import { verifyItemAgainstLedger } from "../work/ledger-verify.js";
import type { WorkItem } from "../work/types.js";
import { WorkItemError } from "../work/work-item.js";
import { decideReport } from "./decide.js";

export type OrderVerb = "seal" | "run" | "report";
export type OrderMissing = "GATE-1" | "GATE-2" | "S7" | "item";

/**
 * `exit` is 0 only for an `awaiting_review` item and `run`: nothing is wrong, the work is already done. 3 is a person
 * to act (an approval, GATE-1), 2 is everything the command cannot run past. `message` is fixed text around an id that
 * passed `assertWorkId`, a closed reason, or `safeText` of an unknown id; it never carries model or author text.
 */
export type Order =
  | { ok: true; item: WorkItem; warnings: string[] }
  | { ok: false; missing: OrderMissing; exit: 0 | 2 | 3; message: string };

const refuse = (missing: OrderMissing, exit: 0 | 2 | 3, message: string): Order => ({
  ok: false,
  missing,
  exit,
  message,
});

/**
 * What a W verb checks before it spends anything (spec section 5). Read-only: one verified ledger read
 * (a corrupt ledger throws, so the command exits 2 with the ledger hint), the item, and `verifyItemAgainstLedger`.
 * It never takes a lock, never repairs, never writes. State is checked before gates, so an `awaiting_review` item
 * reports "already ran" instead of a gate it no longer needs.
 *
 * - seal: a ready item with GATE-1 passing; a started item only when its standing seal's author is measured (it then
 *   short-circuits; resealing a started item is not available yet).
 * - run: GATE-1 for a ready item, then a standing seal; an unmeasured author is a warning, not a refusal, so the line
 *   can show its GATE-3 stop. An in_progress item needs only the standing seal (the seal reuse rule).
 * - report: a trusted evidence pair.
 */
export function checkOrder(location: ProjectLocation, workId: string, verb: OrderVerb, now: Date): Order {
  const events = new Ledger(location.dir).readVerified();
  let item: WorkItem | null;
  try {
    item = findWorkItem(location.dir, workId);
  } catch (err) {
    if (err instanceof WorkItemError) return refuse("item", 2, safeText(err.message));
    throw err;
  }
  if (item === null) return refuse("item", 2, `unknown work item ${safeText(workId)}`);
  const id = item.front.work_id;
  const verdict = verifyItemAgainstLedger(item.front, events);
  if (!verdict.ok) {
    // beginRun is the repairing path; a read-only check must not stand in front of the repair.
    if (verb === "run" && verdict.reason === "w_repairable") {
      return {
        ok: true,
        item,
        warnings: ["item.md is one step behind the ledger; omf run repairs it before it starts"],
      };
    }
    return refuse("item", 2, `work item ${id} does not match the ledger (${verdict.reason}); no gate was read`);
  }
  if (verb === "report") {
    return trustedRecommendation(item.dir, events, item.front) === "none"
      ? refuse("S7", 2, `no trusted evidence (S7 has not run): run omf run ${id}`)
      : { ok: true, item, warnings: [] };
  }
  return lineOrder({ location, item, events, verb, now });
}

function lineOrder(input: {
  location: ProjectLocation;
  item: WorkItem;
  events: readonly LedgerEvent[];
  verb: "seal" | "run";
  now: Date;
}): Order {
  const { location, item, events, verb, now } = input;
  const id = item.front.work_id;
  const state = item.front.state;
  if (state === "awaiting_approval") {
    return refuse("item", 3, `work item ${id} waits for your approval: omf work approve ${id}`);
  }
  if (state === "awaiting_review" && verb === "run") {
    return refuse("item", 0, `work item ${id} already ran and awaits review; see omf report ${id}`);
  }
  if (state !== "ready" && state !== "in_progress") {
    return refuse("item", 2, `work item ${id} is ${state}; omf ${verb} needs a ready or in_progress item`);
  }
  if (claimStatus(item.dir).held) {
    return refuse("item", 2, `work item ${id} is claimed by a run; wait for it to end`);
  }
  if (state === "ready" && decideReport(location, id, now).gate.status !== "pass") {
    return refuse("GATE-1", 3, `GATE-1 is not passing (J2): omf decide lint ${id}`);
  }
  const standing = standingSeal(
    events,
    { goal_id: item.front.goal_id, work_id: id },
    item.dir,
    openVault(location, locationEnv(location)),
  );
  if (verb === "seal") {
    if (state === "in_progress" && standing?.author_measured !== true) {
      return refuse(
        "GATE-2",
        2,
        `work item ${id} has started and has no author-measured seal; resealing a started item is not available yet`,
      );
    }
    return { ok: true, item, warnings: [] };
  }
  if (standing === null) {
    return refuse("GATE-2", 2, `GATE-2 has no passing seal for the current decisions: run omf seal ${id}`);
  }
  if (standing.author_measured) return { ok: true, item, warnings: [] };
  const hint = state === "ready" ? `run omf seal ${id} first` : "a started item cannot be resealed in this version";
  return {
    ok: true,
    item,
    warnings: [`the author stage is unmeasured, so this run will stop at GATE-3 (isolation_unmeasured); ${hint}`],
  };
}

export { openRuntime, sweepItemBestEffort } from "./item-sweep.js";
export { assembleLine, exitForLine, judgeLine, type LineAssembly } from "./w-line.js";
