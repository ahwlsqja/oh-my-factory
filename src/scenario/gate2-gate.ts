import { Ledger } from "../core/ledger.js";
import { exposureCountFor } from "../feedback/events.js";
import { locationEnv } from "../vault/line-guard.js";
import { openVault } from "../vault/vault.js";
import type { Gate } from "../work/gates.js";
import { evaluateGate2Step } from "./gate2-adapter.js";
import { createHostFixtureRunner } from "./fixtures.js";

/**
 * The real GATE-2 as the line runs it. It maps the adapter's outcome onto the line's gate result:
 *
 * - `not_run` is mapped first, with the adapter's closed reason (the guard's code for a guard refusal, `gate_error`
 *   otherwise) and never a stop: a gate that did not evaluate has nothing to route.
 * - `continue` is a pass.
 * - `back_to_S2` is a fail that loops to S2 while the item is `ready`. Once the item is `in_progress` S2 can only reuse the
 *   standing seal (spec §5.3), so looping could change nothing: the fail stops at J3.
 * - a stop is a fail that carries the adapter's route (J2, J3 or J7).
 *
 * The ledger takes the line's clock, so the `gate2.evaluated` stamp follows it. The vault, the runner and the exposure count
 * are built inside `evaluate`: a throw from them escapes, and the sequencer turns it into `not_run gate_error`.
 */
export function gate2Gate(): Gate {
  return {
    id: "GATE-2",
    async evaluate(ctx) {
      const env = locationEnv(ctx.location);
      const outcome = await evaluateGate2Step({
        location: ctx.location,
        item: ctx.item,
        now: ctx.now,
        ledger: new Ledger(ctx.location.dir, () => ctx.now),
        runner: createHostFixtureRunner(),
        vault: openVault(ctx.location, env),
        env,
        exposureCount: exposureCountFor(ctx.events, ctx.item.front.goal_id, ctx.item.front.work_id),
      });
      if (outcome.verdict === "not_run") return { gate: "GATE-2", verdict: "not_run", reasons: outcome.reasons };
      if (outcome.next === "continue") return { gate: "GATE-2", verdict: "pass", reasons: [] };
      if (outcome.next === "back_to_S2") {
        return ctx.item.front.state === "in_progress"
          ? { gate: "GATE-2", verdict: "fail", reasons: outcome.reasons, stop: "J3" }
          : { gate: "GATE-2", verdict: "fail", reasons: outcome.reasons };
      }
      return outcome.stop_route === null
        ? { gate: "GATE-2", verdict: "fail", reasons: outcome.reasons }
        : { gate: "GATE-2", verdict: "fail", reasons: outcome.reasons, stop: outcome.stop_route };
    },
  };
}
