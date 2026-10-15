import { Ledger, type LedgerEvent } from "../../src/core/ledger.js";
import { recordStageMeasurement } from "../../src/isolation/record.js";
import { foldSeals } from "../../src/scenario/events.js";
import type { StationId } from "../../src/work/line-types.js";
import { type LineResult, type Station, runLine } from "../../src/work/sequencer.js";
import { measurement } from "./gate3-parts.js";
import { type JudgeLineFixture, type JudgeLineOptions, setupJudgeLine } from "./judge-line.js";
import { finished } from "./line.js";

export interface SeamOptions extends Omit<JudgeLineOptions, "authorIsolation"> {
  /**
   * The SEAM. Off is the real state of M3f: the author and implementer containers do not exist, so those two stages
   * stay unmeasured and GATE-3 stops the line. On, the stub author stamps its seal `container` and S3 appends the two
   * L2 measurements M3g and M3h will make. That is a statement by this test, not a measurement of a container.
   */
  seam: boolean;
  /** After S5, append a second `judge.round_completed` with another harness context hash, as a drifted harness image would. */
  drift?: boolean;
}
export type Finished = Extract<LineResult, { kind: "finished" }>;
export interface SeamRun {
  jl: JudgeLineFixture;
  result: Finished;
  /** The verified ledger after the line and after `dispose()`. */
  events: LedgerEvent[];
}

export function eventsOfType(run: SeamRun, type: string): LedgerEvent[] {
  return run.events.filter((event) => event.type === type);
}

function withSeamMeasurements(jl: JudgeLineFixture, inner: Station): Station {
  return {
    id: "S3",
    async run(ctx) {
      const result = await inner.run(ctx);
      if (result.kind !== "ok") return result;
      const ledger = new Ledger(jl.l.f.fx.location.dir, ctx.now);
      const scope = { goal_id: ctx.goalId, work_id: ctx.workId, run_id: ctx.runId };
      const seal = foldSeals(ledger.readVerified(), { goal_id: ctx.goalId, work_id: ctx.workId }).latest;
      if (seal === null) throw new Error("the seam needs a standing seal");
      recordStageMeasurement(ledger, scope, ctx.item.dir, measurement("implementer", "L2", 1));
      recordStageMeasurement(ledger, scope, ctx.item.dir, measurement("author", "L2", 1), {
        seal_seq: seal.seq,
        set_sha256: seal.set_sha256,
      });
      return result;
    },
  };
}

function withDriftAfter(jl: JudgeLineFixture, inner: Station): Station {
  return {
    id: "S5",
    async run(ctx) {
      const result = await inner.run(ctx);
      const ledger = new Ledger(jl.l.f.fx.location.dir, ctx.now);
      const judged = ledger
        .readVerified()
        .filter((event) => event.type === "judge.round_completed" && event.payload.run_id === ctx.runId)
        .at(-1);
      if (judged === undefined) throw new Error("S4 recorded no judge round to drift from");
      ledger.append({
        actor: "omf",
        type: "judge.round_completed",
        payload: { ...judged.payload, harness_context_sha256: "f".repeat(64) },
      });
      return result;
    },
  };
}

/** One `runLine` over the real S2, S4, S5, S6, GATE-2 and GATE-3; the containers are the fake daemon's and are disposed before this returns. */
export async function runSeamLine(options: SeamOptions): Promise<SeamRun> {
  const { seam, drift = false, ...fixtureOptions } = options;
  const jl = setupJudgeLine({ ...fixtureOptions, authorIsolation: seam ? "container" : "host_command" });
  const stations: Record<StationId, Station> = { ...jl.stations };
  if (seam) stations.S3 = withSeamMeasurements(jl, stations.S3);
  if (drift) stations.S5 = withDriftAfter(jl, stations.S5);
  let result: Finished;
  try {
    result = finished(await runLine({ location: jl.l.f.fx.location, workId: jl.l.f.workId, stations }));
  } finally {
    await jl.dispose();
  }
  return { jl, result, events: jl.l.f.fx.ledger.readVerified() };
}
