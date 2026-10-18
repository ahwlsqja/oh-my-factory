import { type RoundScope, type WorkAudit, loadAudit } from "../../src/audit/work-audit.js";
import { type Gate3Result, evaluateGate3, measuredFrom } from "../../src/gate/gate3.js";
import type { CommandResult } from "../../src/gate/ports.js";
import { s5Station } from "../../src/judge/s5-station.js";
import { type Classification, classifyOutcome } from "../../src/work/classify.js";
import type { StationContext, StationResult } from "../../src/work/sequencer.js";
import type { ReasonCode } from "../../src/work/w-events.js";
import { allStations, boardOf, cleanInputs } from "./evidence-fixture.js";
import type { ImplementerLine } from "./implementer-e2.js";
import { TempWorkCopyFactory } from "./temp-work-copy.js";
import { makeTempDir } from "./tmp.js";

const exited = (status: number): CommandResult => ({ kind: "exited", status, signal: null, stdout: "", stderr: "" });

const scopeOf = (ctx: StationContext): RoundScope => ({
  goal_id: ctx.goalId,
  work_id: ctx.workId,
  run_id: ctx.runId,
  round: ctx.round,
});

/**
 * The real S5 over the candidate the real S3 just published. The gates and the prove-test run in a temporary copy whose
 * commands all exit 0 (the audit is what this reads); the audit, the canary attribution and the scenario marking are
 * the station's own. `ctx` must be the one S3 ran with, so the evidence inputs are shared.
 */
export async function auditCandidate(line: ImplementerLine, ctx: StationContext): Promise<StationResult> {
  const candidate = await line.stations.candidates.current(ctx);
  if (candidate === null) throw new Error("S3 left no candidate to audit");
  const round = { round: ctx.round, candidate_sha: candidate.head, flawed_signal: false };
  const s5 = s5Station({
    location: line.l.f.fx.location,
    candidates: line.stations.candidates,
    feedback: { released: () => line.released },
    round: () => round,
    copies: async () =>
      new TempWorkCopyFactory({ parent: makeTempDir("omf-e6-copies-"), exec: () => ({ run: async () => exited(0) }) }),
    watchedGlobs: () => [],
  });
  return s5.run(ctx);
}

/** The audit S5 recorded for this round, read through the ledger-checked loader. */
export function auditOf(line: ImplementerLine, ctx: StationContext): WorkAudit | null {
  return loadAudit(ctx.item.dir, scopeOf(ctx), line.l.f.fx.ledger.readVerified());
}

/** GATE-3's pure verdict over the recorded audit alone: every other part is missing, so only the canary is judged on purpose. */
export function gate3Of(line: ImplementerLine, ctx: StationContext): Gate3Result {
  return evaluateGate3(
    measuredFrom({ audit: auditOf(line, ctx), gates: null, contradiction: null, isolation: null, declared: "L2" }),
  );
}

/** What the real classifier makes of an S3 stop when every other input is clean: the stop alone decides. */
export function classifyStop(code: ReasonCode): Classification {
  return classifyOutcome({
    stop: { kind: "station", station: "S3", result: "blocked", reason_code: code },
    stations: allStations("ok"),
    gates: boardOf("pass").aggregate(),
    inputs: cleanInputs(),
    decisions_unmeasured: [],
    gate4_warnings: [],
    injected_gates: [],
    declared_level: "L2",
  });
}
