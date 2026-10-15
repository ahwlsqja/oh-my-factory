import { Ledger } from "../core/ledger.js";
import type { ProjectLocation } from "../core/paths.js";
import { sealFeedbackFromEvents } from "../scenario/events.js";
import { type Ids, randomIds } from "../scenario/intake.js";
import { locationEnv } from "../vault/line-guard.js";
import { openVault } from "../vault/vault.js";
import type { Station, StationResult } from "../work/sequencer.js";
import type { AgentSession } from "./session.js";
import { type S2Outcome, runS2Station } from "./station.js";

export interface S2LineStationDeps {
  location: ProjectLocation;
  session: AgentSession;
  ids?: Ids;
  timeoutMs?: number;
}

/** The digest of the set GATE-2 will read: the one stored now, or the standing one that was reused. */
function digestOf(stage: S2Outcome["stage"]): string | undefined {
  if (stage === null) return undefined;
  if (stage.status === "stored") return stage.set_sha256;
  if (stage.status === "reused") return stage.seal.set_sha256;
  return undefined;
}

function resultOf(outcome: S2Outcome): StationResult {
  const step = outcome.step;
  switch (step.next) {
    case "gate2": {
      const progress_digest = digestOf(outcome.stage);
      return progress_digest === undefined ? { kind: "ok" } : { kind: "ok", progress_digest };
    }
    // An author-quality failure: GATE-2 finds no standing seal and sends the item back, and the visit cap bounds the loop.
    case "retry_s2":
      return { kind: "ok" };
    case "stop":
      switch (step.route) {
        case "J2":
          return { kind: "blocked", reason_code: "j2_open" };
        case "J3":
          return { kind: "blocked", reason_code: "scenarios_need_review" };
        case "J7":
          return { kind: "blocked", reason_code: "gate_blocked" };
      }
  }
}

/**
 * S2 as a station of the line: the seal stage (`runS2Station`) with the ledger, the vault and the feedback of the last GATE-2
 * wired from the item. A stop becomes the station's blocked result with the code of its route (J2 `j2_open`, J3
 * `scenarios_need_review`, J7 `gate_blocked`); a seal that stands, stored now or reused, answers ok with the set digest.
 */
export function s2Station(deps: S2LineStationDeps): Station {
  const { location } = deps;
  return {
    id: "S2",
    async run(ctx) {
      const ledger = new Ledger(location.dir, ctx.now);
      const feedback = sealFeedbackFromEvents(ledger.readVerified(), { goal_id: ctx.goalId, work_id: ctx.workId });
      const outcome = await runS2Station({
        location,
        item: ctx.item,
        session: deps.session,
        ledger,
        vault: openVault(location, locationEnv(location)),
        now: ctx.now,
        ids: deps.ids ?? randomIds(),
        ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
        ...(feedback === null ? {} : { feedback }),
      });
      return resultOf(outcome);
    },
  };
}
