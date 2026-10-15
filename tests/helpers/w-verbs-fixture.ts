import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type StateStore, createMarkdownStore } from "../../src/adapters/state-markdown.js";
import { Ledger, type LedgerEvent } from "../../src/core/ledger.js";
import type { LockOwner } from "../../src/core/lock.js";
import type { ProjectLocation } from "../../src/core/paths.js";
import { claimItem } from "../../src/work/claim.js";
import {
  type ItemVerdict,
  type VerifiedItems,
  verifiedItems,
  verifyItemAgainstLedger,
} from "../../src/work/ledger-verify.js";
import type { WorkItem, WorkState } from "../../src/work/types.js";
import { type WEvent, wEvent } from "../../src/work/w-events.js";
import { WError, type WContext } from "../../src/work/w-verbs.js";
import { makeTempDir } from "./tmp.js";
import { T0, T1, createRecorded, makeNewItem, rewriteItem } from "./work.js";

/** A run id that matches RUN_ID_PATTERN. */
export const W_RUN = "r-20261012T100000Z-ab12";

export interface WFixture {
  ledger: Ledger;
  store: StateStore;
  ctx: WContext;
  /** The item as created: `ready`, normal risk, goal g-fast. */
  item: WorkItem;
  workId: string;
  goalId: string;
  /** The claim this fixture took with `claimItem`; every W verb needs it. */
  claim: LockOwner;
  /** goal_id, work_id and run_id: the common part of every W payload. */
  scope: { goal_id: string; work_id: string; run_id: string };
  /** The item as the store reads it now. */
  fresh: () => WorkItem;
  itemText: () => string;
  ledgerText: () => string;
  events: () => LedgerEvent[];
  verdict: () => ItemVerdict;
  verified: () => VerifiedItems;
  /** Appends a W event and leaves item.md alone: the ledger-ahead half of a crash. */
  appendOnly: (event: WEvent) => LedgerEvent;
  /** Rewrites item.md the way a person with an editor would: no event, no store verb. */
  handEdit: (state: WorkState) => void;
}

export function setupW(): WFixture {
  const dir = makeTempDir("omf-w-");
  const ledger = new Ledger(dir, () => T0);
  const store = createMarkdownStore(dir);
  const item = createRecorded(ledger, store, makeNewItem(), T0);
  const location: ProjectLocation = { repo: dir, id: "p-test", dir };
  const ctx: WContext = { ledger, store, now: () => T1, location };
  const workId = item.front.work_id;
  const goalId = item.front.goal_id;
  const fresh = (): WorkItem => {
    const [read] = store.fetchWorkItemsByIds([workId]);
    if (read === undefined) throw new Error("fixture item vanished");
    return read;
  };
  return {
    ledger,
    store,
    ctx,
    item,
    workId,
    goalId,
    claim: claimItem(item.dir),
    scope: { goal_id: goalId, work_id: workId, run_id: W_RUN },
    fresh,
    itemText: () => readFileSync(join(item.dir, "item.md"), "utf8"),
    ledgerText: () => readFileSync(ledger.file, "utf8"),
    events: () => ledger.readVerified(),
    verdict: () => verifyItemAgainstLedger(fresh().front, ledger.readVerified()),
    verified: () => verifiedItems(store, ledger.readVerified(), goalId),
    appendOnly: (event) => ledger.append(wEvent(event)),
    handEdit: (state) => rewriteItem(fresh(), { state }),
  };
}

/** The WError code of what `fn` throws; "no error" or "other error" otherwise. */
export function wCodeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof WError ? err.code : "other error";
  }
  return "no error";
}

/** The message of what `fn` throws, "" when it does not throw. */
export function wMessageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return "";
}
