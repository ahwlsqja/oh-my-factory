import type { LedgerEvent } from "../core/ledger.js";

/**
 * The mechanical floor of "two-turn proof" (spec §4.5): one met measurement is a reading, two in a
 * row are a pattern. The goal's free-text `decision_rule` stays for the human who signs off (J5).
 */
export const MIN_CONSECUTIVE_MET = 2;

export type SuccessVerdict =
  | { kind: "candidate"; first_met_at: string; consecutive: number; attribution: "before_after" }
  | {
      kind: "undetermined";
      missing: (
        | "target_not_met"
        | "guardrail_breach"
        | "guardrail_unevaluated"
        | "regime_pending"
        | "consecutive"
        | "min_observation"
      )[];
    };

type GuardrailsReading = "pass" | "breach" | "unevaluated" | "none";

/** What `evaluateSuccess` needs from one `goal.measured` event. */
interface Measured {
  ts: string;
  target_met: boolean | null;
  needs_reapproval: boolean;
  guardrails: GuardrailsReading;
}

/**
 * Anything but the three known aggregates reads as `unevaluated`. That includes a legacy event written
 * before `goal.measured` carried the field: an unknown state must never count as a pass (spec F7).
 */
function guardrailsOf(value: unknown): GuardrailsReading {
  return value === "pass" || value === "breach" || value === "none" ? value : "unevaluated";
}

/** The `goal.measured` events of one goal in one regime, oldest first (ledger order). Other regimes never count. */
function measuredIn(events: readonly LedgerEvent[], goalId: string, regime: number): Measured[] {
  const points: Measured[] = [];
  for (const event of events) {
    const { payload } = event;
    if (event.type !== "goal.measured" || payload.goal_id !== goalId || payload.regime !== regime) continue;
    points.push({
      ts: event.ts,
      target_met: payload.target_met === true ? true : payload.target_met === false ? false : null,
      needs_reapproval: payload.needs_reapproval === true,
      guardrails: guardrailsOf(payload.guardrails),
    });
  }
  return points;
}

/** Met, no pending regime change, and every guardrail either passes or there are none. */
function qualifies(point: Measured): boolean {
  return (
    point.target_met === true && !point.needs_reapproval && (point.guardrails === "pass" || point.guardrails === "none")
  );
}

/**
 * Is the goal a success candidate (spec §4.5)? Pure over the events it is given, with the clock passed
 * in. The newest measurement of the regime must be met with the guardrails passing and no regime
 * change pending. A streak of at least `MIN_CONSECUTIVE_MET` such measurements, running back from the
 * newest and stopped by the first that does not qualify, must span `minObservationMs` up to `now`.
 * A guardrail that was never evaluated (no bands file, or a baseline that is still too short) is
 * never a pass, so such a goal cannot succeed (enforcement test E4). The result is correlational
 * ("before_after"): it says the target was met, not that the work caused it.
 */
export function evaluateSuccess(args: {
  events: readonly LedgerEvent[];
  goalId: string;
  regime: number;
  minObservationMs: number;
  now: Date;
}): SuccessVerdict {
  const points = measuredIn(args.events, args.goalId, args.regime);
  const latest = points.at(-1);
  if (latest === undefined) return { kind: "undetermined", missing: ["consecutive", "min_observation"] };

  const missing: Extract<SuccessVerdict, { kind: "undetermined" }>["missing"] = [];
  if (latest.needs_reapproval || latest.target_met === null) missing.push("regime_pending");
  else if (!latest.target_met) missing.push("target_not_met");
  if (latest.guardrails === "breach") missing.push("guardrail_breach");
  else if (latest.guardrails === "unevaluated") missing.push("guardrail_unevaluated");
  if (missing.length > 0) return { kind: "undetermined", missing };

  let first = latest;
  let consecutive = 0;
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i];
    if (point === undefined || !qualifies(point)) break;
    consecutive += 1;
    first = point;
  }
  if (consecutive < MIN_CONSECUTIVE_MET) missing.push("consecutive");
  if (args.now.getTime() - Date.parse(first.ts) < args.minObservationMs) missing.push("min_observation");
  if (missing.length > 0) return { kind: "undetermined", missing };
  return { kind: "candidate", first_met_at: first.ts, consecutive, attribution: "before_after" };
}
