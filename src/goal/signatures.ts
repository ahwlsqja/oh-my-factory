import { canonicalize, sha256Hex } from "../core/canonical-json.js";
import type { LedgerEvent } from "../core/ledger.js";
import type { WorkState } from "../work/types.js";

/** The G stations a tick runs (spec §4.4). Each station outcome yields one signature. */
export type Station = "audit" | "measure" | "reconcile" | "dispatch" | "refresh";

/**
 * How a station ended. `waiting` is normal operation (nothing to do yet) and is never counted,
 * so a watch goal that idles for weeks cannot trip the breaker.
 */
export type OutcomeClass = "ok" | "stopped" | "failed" | "empty" | "waiting";

export interface StationOutcome {
  station: Station;
  outcome_class: OutcomeClass;
  /** A code or raw text; `signatureOf` normalizes it. */
  reason: string;
}

/** The same signature three times in a row of ticks since the last resume or approval escalates to J6 (spec §4.4). */
export const SIGNATURE_LIMIT = 3;

const REASON_CAP = 120;

/**
 * Makes two runs of the same failure comparable: lowercase, paths to `<path>`, long hex runs (commit and
 * hash text) to `<hex>`, metric ids (`m-` followed by words) to `<metric>` (a metric id is an E2 canary, and stop reasons such as `metric lock tampered: m-p95` reach the public `signatures` list), every digit run to `#`, whitespace collapsed, capped at 120 characters. Paths are
 * replaced first because they contain the digits and hex runs that would otherwise leak into the signature.
 */
export function normalizeReason(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/(?:[\w.@+~-]*\/)+[\w.@+~-]*/g, "<path>")
    .replace(/\bm-[a-z0-9]+(?:-[a-z0-9]+)*\b/g, "<metric>")
    .replace(/\b[0-9a-f]{8,}\b/g, "<hex>")
    .replace(/[0-9]+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, REASON_CAP)
    .trimEnd();
}

/**
 * `station|class|reason`, plus `|p:<12 hex of the progress signature>` for `ok` outcomes: a healthy loop
 * whose state moves every tick therefore never repeats a signature, while an `ok` tick that changed nothing
 * does. Failure classes ignore progress on purpose, because "the same failure again" is what they count.
 * Returns null for `waiting`, which is not counted.
 */
export function signatureOf(outcome: StationOutcome, progressSig: string | null): string | null {
  if (outcome.outcome_class === "waiting") return null;
  const base = `${outcome.station}|${outcome.outcome_class}|${normalizeReason(outcome.reason)}`;
  if (outcome.outcome_class !== "ok") return base;
  return `${base}|p:${progressSig === null ? "-" : progressSig.slice(0, 12)}`;
}

export interface ProgressInput {
  regime: number;
  items: { work_id: string; state: WorkState; updated_at: string }[];
  metrics: { metric_id: string; value: number | null }[];
}

function byKey<T>(key: (value: T) => string): (a: T, b: T) => number {
  return (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}

/**
 * A hash of everything a tick could have moved: the regime, every work item's state and last update, and
 * every measured value. Two ticks with the same hash changed nothing observable, which is the stall test
 * (spec §4.4 "no progress"). Order-independent.
 */
export function progressSignature(input: ProgressInput): string {
  return sha256Hex(
    canonicalize({
      regime: input.regime,
      items: [...input.items].sort(byKey((item) => item.work_id)),
      metrics: [...input.metrics].sort(byKey((metric) => metric.metric_id)),
    }),
  );
}

interface TickEndedView {
  signatures: string[];
  progress_sig: string | null;
  reconciled: boolean;
}

/** Reads the fields the breaker needs from a goal.tick_ended event; a malformed payload stops the line. */
function tickEndedView(event: LedgerEvent): TickEndedView {
  const { signatures, progress_sig, reconciled } = event.payload;
  if (
    !Array.isArray(signatures) ||
    !signatures.every((signature) => typeof signature === "string") ||
    (progress_sig !== null && typeof progress_sig !== "string") ||
    typeof reconciled !== "boolean"
  ) {
    throw new Error(`invalid goal.tick_ended event at seq ${event.seq}: malformed payload`);
  }
  return { signatures: signatures as string[], progress_sig: progress_sig as string | null, reconciled };
}

/** The goal.tick_ended events of this goal since the latest goal.resumed or goal.approved (a person acted: counting restarts). */
function ticksInWindow(events: readonly LedgerEvent[], goalId: string): TickEndedView[] {
  let start = 0;
  events.forEach((event, index) => {
    if ((event.type === "goal.resumed" || event.type === "goal.approved") && event.payload.goal_id === goalId) {
      start = index + 1;
    }
  });
  return events
    .slice(start)
    .filter((event) => event.type === "goal.tick_ended" && event.payload.goal_id === goalId)
    .map(tickEndedView);
}

/** How often each signature was recorded in the current window. Counts come from the ledger, so a restart cannot reset them. */
export function signatureCounts(events: readonly LedgerEvent[], goalId: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const tick of ticksInWindow(events, goalId)) {
    for (const signature of tick.signatures) counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  return counts;
}

/**
 * The progress signature of the latest tick whose model answered. A failed model call is retryable (it set
 * no baseline); an unchanged state after a model RESPONSE is not (spec §4.4).
 */
export function previousProgressSig(events: readonly LedgerEvent[], goalId: string): string | null {
  const reconciled = ticksInWindow(events, goalId).filter((tick) => tick.reconciled);
  return reconciled.at(-1)?.progress_sig ?? null;
}

/** The first signature in `current` whose earlier count plus its occurrences so far in `current` reaches the limit, or null. */
export function tripped(counts: ReadonlyMap<string, number>, current: readonly string[]): string | null {
  const seen = new Map<string, number>();
  for (const signature of current) {
    const now = (seen.get(signature) ?? 0) + 1;
    seen.set(signature, now);
    if ((counts.get(signature) ?? 0) + now >= SIGNATURE_LIMIT) return signature;
  }
  return null;
}
