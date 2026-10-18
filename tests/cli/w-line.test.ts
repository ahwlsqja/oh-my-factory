import { describe, expect, it } from "vitest";
import { assembleLine, exitForLine } from "../../src/cli/w-assembly.js";
import type { EvidenceDoc } from "../../src/work/evidence.js";
import type { HandoffRecord, JCode } from "../../src/work/handoff.js";
import { STATION_IDS } from "../../src/work/line-types.js";
import type { WOutcome } from "../../src/work/outcome.js";
import { type LineResult, runLine } from "../../src/work/sequencer.js";
import { setupJudgeLine } from "../helpers/judge-line.js";
import { finished } from "../helpers/line.js";

// The exit table of `omf run` (M3h-D5): a result a person must look at is 3, the environment (J7) and an aborted line are 2,
// a flawed result is 1, a success is 0. The table reads the handoff route, because the outcome alone cannot tell J4 from J7.
const RUN = "r-20261019T090000Z-ab12";

function ended(outcome: WOutcome, route: JCode | null): LineResult {
  return {
    kind: "finished",
    run_id: RUN,
    outcome,
    disposition: { action: "park", item_state: "unchanged", counts_toward_stop_if: false },
    reason_code: route === null ? null : "gate_blocked",
    evidence: {} as unknown as EvidenceDoc,
    handoff:
      route === null
        ? null
        : ({ decision_required: { j: route, question: "q", options: [] } } as unknown as HandoffRecord),
  };
}

describe("exitForLine", () => {
  it.each([
    ["success", null, 0],
    ["flawed", null, 1],
    ["flawed", "J4", 1],
    ["blocked", "J2", 3],
    ["blocked", "J3", 3],
    ["blocked", "J4", 3],
    ["blocked", "J6", 3],
    ["blocked", "J8", 3],
    ["blocked", "J7", 2],
    ["manual", "J7", 2],
    ["blocked", null, 2],
  ] as const)("%s with handoff route %s exits %i", (outcome, route, code) => {
    expect(exitForLine(ended(outcome, route))).toBe(code);
  });

  it("exits 2 for an aborted line", () => {
    expect(exitForLine({ kind: "aborted", run_id: RUN, reason: "claim_lost", code: null, wcode: null, at: "S3" })).toBe(
      2,
    );
  });
});

describe("assembleLine", () => {
  it("builds all seven stations, and its S2 reuses the standing seal instead of calling an author", async () => {
    const jl = setupJudgeLine();
    const { location } = jl.l.f.fx;
    const workId = jl.l.f.workId;
    const types = (): string[] => jl.l.f.fx.ledger.readVerified().map((event) => event.type);

    // A first line over the stub author seals the item (the stamp is host_command, so the author stage stays unmeasured).
    await runLine({ location, workId, stations: jl.stations, onLineEnd: jl.dispose });
    const sealRequests = types().filter((type) => type === "seal.requested").length;
    expect(sealRequests).toBe(1);

    const line = assembleLine({ location, runtime: jl.runtime, env: {} });
    expect(Object.keys(line.stations).sort()).toEqual([...STATION_IDS].sort());
    for (const id of STATION_IDS) expect(line.stations[id].id).toBe(id);

    // The project has no [implementer] image, so the real S3 stops the line before it touches a container or a key.
    const result = finished(await runLine({ location, workId, stations: line.stations, onLineEnd: line.onLineEnd }));
    expect(result.evidence.stations.S2).toBe("ok");
    expect(result.outcome).toBe("blocked");
    expect(result.reason_code).toBe("infra_failure");
    expect(types().filter((type) => type === "seal.requested")).toHaveLength(sealRequests);
    expect(jl.liveContainers()).toEqual([]);
  });
});
