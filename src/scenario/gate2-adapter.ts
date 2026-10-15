import type { Ledger } from "../core/ledger.js";
import { decisionsDigest, foldDecisions } from "../decision/state.js";
import type { DecisionScope } from "../decision/types.js";
import { guardRefusal } from "../vault/line-guard.js";
import { foldSeals } from "./events.js";
import { type Gate2Context, type Gate2Result, type Gate2Route, gate2EventFor, runGate2, sealFeedbackFor } from "./gate2.js";
import type { SealFeedback } from "./types.js";

/** The routes that end the line (M3c-D21); `back_to_S2` is the only one that loops. */
export type StopRoute = Exclude<Gate2Route, "back_to_S2">;
export type Gate2Verdict = "pass" | "fail" | "not_run";
/** The reason a throw that is not a guard refusal leaves behind. Matches `^[a-z0-9_]+$`, the shape M3b2 requires of gate reasons. */
export const GATE_ERROR_REASON = "gate_error";

/**
 * What the line needs from one GATE-2 evaluation, without M3b2's types: `verdict` is its tri-state, `next` says
 * whether to continue, loop to S2 or stop, and `stop_route` names J2, J3 or J7 when it stops. M3b2's `Gate`
 * adapter is a rename of these fields (see docs/m3c-spec-deviations.md).
 */
export interface Gate2Outcome {
  gate: "GATE-2";
  verdict: Gate2Verdict;
  reasons: string[];
  next: "continue" | "back_to_S2" | "stop";
  stop_route: StopRoute | null;
  /** Decision ids and plain counts only (M3c-D12); null unless the route is back_to_S2. */
  feedback: SealFeedback | null;
  /** Resolved quantitative decision ids: never run, never success (M3-D17). */
  not_run: string[];
  /** null when the gate threw. */
  result: Gate2Result | null;
}

/** Pure: a `Gate2Result` becomes the outcome. A J2, J3 or J7 route stops the line; looping on it would only reseal until a visit cap. */
export function gate2Outcome(result: Gate2Result): Gate2Outcome {
  if (result.status === "pass") {
    return { gate: "GATE-2", verdict: "pass", reasons: [], next: "continue", stop_route: null, feedback: null, not_run: result.not_run, result };
  }
  const reasons = [...new Set(result.reasons.map((reason) => reason.code))];
  const base = { gate: "GATE-2" as const, verdict: "fail" as const, reasons, not_run: result.not_run, result };
  if (result.route === "back_to_S2") {
    return { ...base, next: "back_to_S2", stop_route: null, feedback: sealFeedbackFor(result) };
  }
  return { ...base, next: "stop", stop_route: result.route, feedback: null };
}

export interface Gate2StepContext extends Gate2Context {
  ledger: Ledger;
}

/**
 * One GATE-2 evaluation as the line runs it: `runGate2` (reads and probes, appends nothing), then exactly one
 * `gate2.evaluated` (M3c-D7). A throw (a guard refusal, a damaged install, a runner that may not run) is
 * `not_run`, stops at J7 and appends nothing, because nothing was evaluated. Its reason is the guard's closed code
 * for a guard refusal and `gate_error` for anything else. The event's digests are read
 * inside the append, from the same ledger the event joins. The line is the only writer during a pass.
 */
export async function evaluateGate2Step(ctx: Gate2StepContext): Promise<Gate2Outcome> {
  let result: Gate2Result;
  try {
    result = await runGate2(ctx);
  } catch (err) {
    // A guard refusal keeps the closed code the S2 station reports for the same cause (docs/m3c-spec-deviations.md V9).
    const reason = guardRefusal(err) ?? GATE_ERROR_REASON;
    return { gate: "GATE-2", verdict: "not_run", reasons: [reason], next: "stop", stop_route: "J7", feedback: null, not_run: [], result: null };
  }
  const scope: DecisionScope = { goal_id: ctx.item.front.goal_id, work_id: ctx.item.front.work_id };
  ctx.ledger.appendWith((events) => {
    const seal = foldSeals(events, scope).latest;
    return gate2EventFor(scope, seal?.round ?? 1, result, {
      seal_id: seal?.seal_id ?? null,
      set_sha256: seal?.set_sha256 ?? null,
      decisions_digest: decisionsDigest(foldDecisions(events, scope)),
    });
  });
  return gate2Outcome(result);
}
