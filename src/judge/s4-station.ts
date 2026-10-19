import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { NotGoldenError } from "../container/measure.js";
import type { OwnedLabels } from "../container/spec.js";
import { canonicalize, sha256Hex } from "../core/canonical-json.js";
import { readConfig } from "../core/config.js";
import { Ledger } from "../core/ledger.js";
import { INTERFACE_DECISION_ID } from "../decision/types.js";
import { trainCounts } from "../feedback/tally.js";
import { locationEnv } from "../vault/line-guard.js";
import { openVault } from "../vault/vault.js";
import type { Station, StationResult } from "../work/sequencer.js";
import type { ReasonCode } from "../work/w-events.js";
import { releaseHeld } from "./engine.js";
import { judgeRoundEvent } from "./events.js";
import { harnessSetOf, roundFacts, toScenarioResults, writeTallyView } from "./results.js";
import type { RoundHolder, RoundLease } from "./round-state.js";
import { JudgeRoundError } from "./round.js";
import type { RoundVerdict } from "./round.js";
import { loadStandingSet } from "./standing-set.js";
import type { ResolvedDeps } from "./stations.js";
import { sweepOrphans } from "./state.js";

const blocked = (reason_code: ReasonCode): StationResult => ({ kind: "blocked", reason_code });

/**
 * Closed codes only; the message never leaves (it may hold a daemon's words). A container that is not golden and a round
 * that cannot be judged at all (an invalid set, no scenarios) are J7 `gate_blocked`: a person looks. Anything else is
 * the environment: `infra_failure`.
 */
function stopFor(err: unknown): ReasonCode {
  if (err instanceof NotGoldenError || (err instanceof Error && err.cause instanceof NotGoldenError))
    return "gate_blocked";
  if (err instanceof JudgeRoundError && (err.code === "set_invalid" || err.code === "no_scenarios"))
    return "gate_blocked";
  return "infra_failure";
}

/**
 * S4, the judge (spec §5.5): the train split's behavior scenarios plus the contradiction canaries of BOTH splits, k
 * repetitions each, in the two-container judge. Never a test-split behavior scenario: that split is spent once, by S6, after
 * GATE-3. It reads only the ledger and the vault set the seal pinned, and a set whose digest differs is not
 * run. It writes `sealed.train` (flaky apart), one `judge.round_completed` event and a host-only tally file by scenario
 * ref, and leaves the round state and the SUT image for S5 and S6. Any failure is one closed code and nothing else.
 */
export function s4Station(deps: ResolvedDeps, holder: RoundHolder): Station {
  const { location, runtime, engine } = deps;
  return {
    id: "S4",
    async run(ctx) {
      const candidate = await deps.candidates.current(ctx);
      if (candidate === null) return blocked("infra_failure");
      const ledger = new Ledger(location.dir, ctx.now);
      const events = ledger.readVerified();
      const standing = loadStandingSet({
        vault: openVault(location, locationEnv(location)),
        events,
        scope: { goal_id: ctx.goalId, work_id: ctx.workId },
      });
      if (!standing.ok) return blocked("gate_blocked");
      const contract = standing.state.decisions.find((decision) => decision.id === INTERFACE_DECISION_ID)?.interface;
      if (contract === undefined || contract === null) return blocked("gate_blocked");
      let config: ReturnType<typeof readConfig>["judge"];
      try {
        config = readConfig(location.dir).judge;
      } catch {
        return blocked("infra_failure");
      }
      if (
        runtime.context === null ||
        config.docker_context === null ||
        config.sut_base_image === null ||
        config.harness_base_image === null
      ) {
        return blocked("infra_failure");
      }

      const scenarios = harnessSetOf(standing.active, standing.state);
      const judged = scenarios.filter((s) => s.split === "train" || s.kind === "contradiction_canary");
      const stageRoot = (deps.stageRoot ?? ((dir: string, run: string) => join(dir, "runs", run, "judge")))(
        ctx.item.dir,
        ctx.runId,
      );
      const contextRoot = join(stageRoot, `${ctx.round}-train`);
      const labels: OwnedLabels = { work_id: ctx.workId, run_id: ctx.runId, round: ctx.round, role: "sut" };
      let judgement: { lease: RoundLease; verdict: RoundVerdict };
      try {
        // A daemon that answers `docker info` on a local unix socket; anything else never builds or runs candidate code.
        const info = await runtime.info();
        if (!info.ok || !(await runtime.endpoint()).local) return blocked("infra_failure");
        await releaseHeld(runtime, engine, holder);
        await sweepOrphans({
          runtime,
          itemDir: ctx.item.dir,
          currentRunId: ctx.runId,
          workId: ctx.workId,
          projectDir: location.dir,
        });
        mkdirSync(contextRoot, { recursive: true, mode: 0o700 });
        const lease = await engine.buildRoundImages({
          runtime,
          config,
          contract,
          candidate: { quarantine: candidate.quarantine, sha: candidate.head },
          labels,
          contextRoot,
        });
        holder.hold(lease);
        const verdict = await engine.runJudgeRound({
          runtime,
          measure: {
            runtime,
            sink: ledger,
            scope: { goal_id: ctx.goalId, work_id: ctx.workId, run_id: ctx.runId },
            itemDir: ctx.item.dir,
            now: ctx.now,
          },
          config,
          images: lease,
          scenarios: judged,
          phase: "train",
          candidate_sha: candidate.head,
          run: contract.run,
          stageRoot,
          forbidden: engine.forbiddenPaths(location),
          round: ctx.round,
          now: ctx.now,
        });
        judgement = { lease, verdict };
      } catch (err) {
        return blocked(stopFor(err));
      } finally {
        rmSync(contextRoot, { recursive: true, force: true });
      }

      const { lease, verdict } = judgement;
      const counts = trainCounts(toScenarioResults(verdict.tallies));
      const scope = { goal_id: ctx.goalId, work_id: ctx.workId, run_id: ctx.runId, round: ctx.round };
      ledger.append(judgeRoundEvent(scope, roundFacts(verdict)));
      writeTallyView(ctx.item.dir, {
        runId: ctx.runId,
        round: ctx.round,
        phase: "train",
        candidateSha: candidate.head,
        tallies: verdict.tallies,
      });
      ctx.inputs.sealed.train = counts;
      holder.begin({
        round: ctx.round,
        candidate_sha: candidate.head,
        lease,
        run: contract.run,
        train: verdict,
        test: null,
        trainDigest: standing.trainDigest,
        testDigest: standing.testDigest,
        scenarios,
        flawed_signal: false,
      });
      const runs = verdict.tallies.map((t) => [t.scenario_ref, t.verdict]);
      return { kind: "ok", progress_digest: sha256Hex(canonicalize({ candidate_sha: candidate.head, runs })) };
    },
  };
}
