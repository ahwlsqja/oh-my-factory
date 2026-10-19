import type { LedgerEvent } from "../core/ledger.js";
import { validateDef } from "../core/schema.js";
import { decisionsDigest } from "../decision/state.js";
import type { DecisionScope } from "../decision/types.js";
import { loadRunIsolation } from "../isolation/record.js";
import { loadStandingSet } from "../judge/standing-set.js";
import type { Gate2EventInput, SealRecord } from "../scenario/events.js";
import type { Vault } from "../vault/vault.js";

/** A seal the line may build on, and whether a container measured the author that wrote it. */
export interface StandingSeal {
  seal: SealRecord;
  author_measured: boolean;
}

type Gate2Answer = Pick<Gate2EventInput, "status" | "seal_id" | "set_sha256">;

/**
 * The item's latest `gate2.evaluated` of actor `omf` that passes its schema, read like `sealFeedbackFromEvents` reads them:
 * an event that names another item or fails validation is not the item's evaluation.
 */
function latestGate2(events: readonly LedgerEvent[], scope: DecisionScope): Gate2Answer | null {
  let found: Gate2Answer | null = null;
  for (const event of events) {
    if (event.type !== "gate2.evaluated" || event.actor !== "omf") continue;
    if (event.payload["goal_id"] !== scope.goal_id || event.payload["work_id"] !== scope.work_id) continue;
    if (!validateDef("scenario.schema.json", "ev_gate2_evaluated", event.payload).ok) continue;
    found = event.payload as unknown as Gate2Answer;
  }
  return found;
}

/**
 * The seal `omf run` may build on (spec §5.3): the latest valid seal of the item, whose vault files still hash to the digest
 * the ledger pinned (`loadStandingSet` checks that, so a tampered or deleted set is not standing), written against the
 * decisions as they are now, and passed by the item's latest GATE-2 evaluation. `author_measured` is true only when the
 * author stage reads L2 for exactly this seal under `loadRunIsolation`, the rule the evidence uses: a seal stamped
 * `host_command`, one with no measurement bound to it, and one measured below L2 are all not measured.
 *
 * Pure over the verified events and a read of the vault; nothing is repaired and nothing is written. `vault` is a fourth
 * argument because the set digest cannot be recomputed from the item directory alone.
 */
export function standingSeal(
  events: readonly LedgerEvent[],
  scope: DecisionScope,
  itemDir: string,
  vault: Vault,
): StandingSeal | null {
  const set = loadStandingSet({ vault, events, scope });
  if (!set.ok) return null;
  if (set.seal.decisions_digest !== decisionsDigest(set.state)) return null;
  const gate2 = latestGate2(events, scope);
  if (
    gate2 === null ||
    gate2.status !== "pass" ||
    gate2.seal_id !== set.seal.seal_id ||
    gate2.set_sha256 !== set.seal.set_sha256
  ) {
    return null;
  }
  // The run id only labels the answer: the author stage is matched by seal, not by run.
  const isolation = loadRunIsolation(itemDir, { ...scope, run_id: "standing" }, events);
  return { seal: set.seal, author_measured: isolation.stages.author?.level === "L2" };
}
