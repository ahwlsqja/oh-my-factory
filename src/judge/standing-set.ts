import type { LedgerEvent } from "../core/ledger.js";
import { foldDecisions } from "../decision/state.js";
import type { DecisionScope, DecisionState } from "../decision/types.js";
import { effectiveScenarios, foldSeals, foldStatuses } from "../scenario/events.js";
import type { SealRecord } from "../scenario/events.js";
import type { StoredScenario } from "../scenario/types.js";
import { readScenarioSet, splitDigest } from "../vault/vault.js";
import type { Vault } from "../vault/vault.js";

/**
 * The sealed set the judge reads: the latest seal, the vault files proven to be that seal's by digest, the scenarios
 * whose ledger status is active, and the split digests M3d keys its ladder and its single test run on. The failures are
 * the ones GATE-2 reports (J3 or back to S2); a station that meets one judges nothing.
 */
export type StandingSet =
  | {
      ok: true;
      seal: SealRecord;
      state: DecisionState;
      active: StoredScenario[];
      trainDigest: string;
      testDigest: string;
    }
  | { ok: false; reason: "no_seal" | "ledger_anomaly" | "set_unreadable" | "set_tampered" };

export function loadStandingSet(input: {
  vault: Vault;
  events: readonly LedgerEvent[];
  scope: DecisionScope;
}): StandingSet {
  const { vault, events, scope } = input;
  const seals = foldSeals(events, scope);
  const seal = seals.latest;
  if (seal === null) return { ok: false, reason: "no_seal" };
  if (seals.anomalies > 0) return { ok: false, reason: "ledger_anomaly" };
  const read = readScenarioSet(vault, { work_id: scope.work_id, seal_id: seal.seal_id });
  if (!read.ok) return { ok: false, reason: "set_unreadable" };
  if (read.set_sha256 !== seal.set_sha256) return { ok: false, reason: "set_tampered" };
  const folded = foldStatuses(events, scope, seal.seal_id);
  if (folded.anomalies > 0) return { ok: false, reason: "ledger_anomaly" };
  const active = effectiveScenarios(read.scenarios, folded.statuses)
    .filter((entry) => entry.status === "active")
    .map((entry) => entry.scenario);
  return {
    ok: true,
    seal,
    state: foldDecisions(events, scope),
    active,
    trainDigest: splitDigest(read.scenarios, folded.statuses, "train"),
    testDigest: splitDigest(read.scenarios, folded.statuses, "test"),
  };
}
