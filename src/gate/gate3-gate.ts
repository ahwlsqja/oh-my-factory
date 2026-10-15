import { type RoundScope, auditHeadSha, loadAudit } from "../audit/work-audit.js";
import { readConfig } from "../core/config.js";
import { Ledger } from "../core/ledger.js";
import { loadRunIsolation } from "../isolation/record.js";
import { contradictionVerdictOf, imageCheck } from "../judge/events.js";
import type { Gate } from "../work/gates.js";
import { gate3EvaluatedEvent, gatesVerdictFromEvents } from "./events.js";
import { contradictionState, evaluateGate3, measuredFrom } from "./gate3.js";

/**
 * The real GATE-3 as the line runs it (spec §5.0). Parameterless like `gate2Gate()`; it reads nothing but the ledger
 * events in its context, the item directory and `config.toml`: the round's audit through the ledger-checked `loadAudit`,
 * the gate verdict from the round's `gates.evaluated` event, the contradiction verdict from the round's judge event
 * compared with the audit's `head_sha` (both ledger values), and the run's isolation from the measurement events.
 * `preflight.json`, `isolation.json` and a raw audit file are never inputs.
 *
 * "Judge config unchanged" has two halves, the judge files the audit checked and the harness image the judge ran: a run
 * whose images changed, or whose judge left no event, is not unchanged. Every evaluation appends `gate3.evaluated` with
 * the round; a throw (an unreadable context, a ledger fault) is `not_run` / `gate_error`, never a pass.
 */
export function gate3Gate(): Gate {
  return {
    id: "GATE-3",
    evaluate(ctx) {
      try {
        const { goal_id, work_id } = ctx.item.front;
        const scope: RoundScope = { goal_id, work_id, run_id: ctx.runId, round: ctx.round };
        const { events } = ctx;
        const itemDir = ctx.item.dir;
        let measured = measuredFrom({
          audit: loadAudit(itemDir, scope, events),
          gates: gatesVerdictFromEvents(events, scope),
          contradiction: contradictionState(contradictionVerdictOf(events, scope), auditHeadSha(events, scope) ?? ""),
          isolation: loadRunIsolation(itemDir, scope, events),
          declared: readConfig(ctx.location.dir).isolation.declared,
        });
        if (measured.judge_config === "unchanged") {
          const check = imageCheck(events, scope);
          if (check !== "match") measured = { ...measured, judge_config: check === "mismatch" ? "changed" : "not_run" };
        }
        const result = evaluateGate3(measured);
        new Ledger(ctx.location.dir, () => ctx.now).append(gate3EvaluatedEvent(scope, result));
        return { gate: "GATE-3", verdict: result.passed ? "pass" : "fail", reasons: result.failed };
      } catch {
        return { gate: "GATE-3", verdict: "not_run", reasons: ["gate_error"] };
      }
    },
  };
}
