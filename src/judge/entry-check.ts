import { Ledger } from "../core/ledger.js";
import type { ProjectLocation } from "../core/paths.js";
import { feedbackEntryCheck } from "../feedback/test-run.js";
import { locationEnv } from "../vault/line-guard.js";
import { openVault } from "../vault/vault.js";
import type { Station } from "../work/sequencer.js";
import type { CandidateSource } from "./candidate.js";
import { loadStandingSet } from "./standing-set.js";

/** The part of `JudgeLineDeps` the entry check reads; the full deps satisfy it. */
export interface EntryCheckDeps {
  location: ProjectLocation;
  candidates: CandidateSource;
}

/**
 * Wraps S2 with the call site of `feedbackEntryCheck`: after the inner station answers ok (the seal stands), before
 * GATE-2 and long before S3 opens a round, so a line that can never reach its test split stops while it costs nothing
 * (spec §5.7). Budget first: no declared disclosure budget is `disclosure_unavailable` (J8). A consumed
 * split with no result, or a result recorded for another candidate, stops with the test-run codes; an unknown candidate never
 * matches a recorded result, so it fails closed. When the inner station did not answer ok, or the seal cannot be read,
 * there is nothing to decide here and the answer passes on: GATE-2 reports those.
 */
export function withEntryCheck(inner: Station, deps: EntryCheckDeps): Station {
  return {
    id: inner.id,
    async run(ctx) {
      const result = await inner.run(ctx);
      if (result.kind !== "ok") return result;
      const { location } = deps;
      const events = new Ledger(location.dir, ctx.now).readVerified();
      const standing = loadStandingSet({
        vault: openVault(location, locationEnv(location)),
        events,
        scope: { goal_id: ctx.goalId, work_id: ctx.workId },
      });
      if (!standing.ok) return result;
      const candidate = await deps.candidates.current(ctx);
      const sha = candidate === null ? null : candidate.head;
      const check = feedbackEntryCheck(events, ctx.goalId, ctx.workId, standing.testDigest, sha);
      if (check.status === "proceed") return result;
      if (check.status === "not_declared") return { kind: "blocked", reason_code: "disclosure_unavailable" };
      return { kind: "blocked", reason_code: check.reason_code };
    },
  };
}
