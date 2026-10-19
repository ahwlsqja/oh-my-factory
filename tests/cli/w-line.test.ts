import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assembleLine, exitForLine } from "../../src/cli/w-assembly.js";
import { acquireLock, releaseLock, sealLockFile } from "../../src/core/lock.js";
import type { EvidenceDoc } from "../../src/work/evidence.js";
import type { HandoffRecord, JCode } from "../../src/work/handoff.js";
import { STATION_IDS } from "../../src/work/line-types.js";
import type { WOutcome } from "../../src/work/outcome.js";
import { type LineResult, runLine } from "../../src/work/sequencer.js";
import { plantOwnedContainer } from "../helpers/fake-docker.js";
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

describe("assembleLine container sweeps", () => {
  const EARLIER = "r-20261001T080000Z-dddd";
  const THIS_RUN = "r-20261019T100000Z-cdef";
  const names = (jl: ReturnType<typeof setupJudgeLine>): string[] => jl.liveContainers().sort();

  async function sealed() {
    const jl = setupJudgeLine();
    const { location } = jl.l.f.fx;
    await runLine({ location, workId: jl.l.f.workId, stations: jl.stations, onLineEnd: jl.dispose });
    mkdirSync(join(jl.l.f.item.dir, "runs", EARLIER), { recursive: true });
    return { jl, location, workId: jl.l.f.workId };
  }

  it("removes what a killed earlier run and a killed seal pass left, at the start, even when the line stops before S3 creates anything", async () => {
    const { jl, location, workId } = await sealed();
    jl.fake.state.containers = {};
    const implementer = plantOwnedContainer(jl.fake.state, "implementer", EARLIER);
    const author = plantOwnedContainer(jl.fake.state, "author", EARLIER);
    const sut = plantOwnedContainer(jl.fake.state, "sut", EARLIER);
    expect(names(jl)).toEqual([author, implementer, sut].sort());
    const line = assembleLine({ location, runtime: jl.runtime, env: {} });
    // The project has no [implementer] image: the real S3 stops the line before it touches a container.
    const result = finished(await runLine({ location, workId, stations: line.stations, onLineEnd: line.onLineEnd }));
    expect(result.reason_code).toBe("infra_failure");
    expect(names(jl)).toEqual([]);
  });

  it("leaves an author container alone while an omf seal holds seal.lock", async () => {
    const { jl, location, workId } = await sealed();
    jl.fake.state.containers = {};
    const author = plantOwnedContainer(jl.fake.state, "author", EARLIER);
    const implementer = plantOwnedContainer(jl.fake.state, "implementer", EARLIER);
    const lock = sealLockFile(jl.l.f.item.dir);
    acquireLock(lock);
    try {
      const line = assembleLine({ location, runtime: jl.runtime, env: {} });
      await runLine({ location, workId, stations: line.stations, onLineEnd: line.onLineEnd });
    } finally {
      releaseLock(lock);
    }
    expect(names(jl)).toEqual([author]);
    expect(names(jl)).not.toContain(implementer);
  });

  it("removes an implementer container the line could not remove itself, when the line stops", async () => {
    const { jl, location, workId } = await sealed();
    jl.fake.state.containers = {};
    const line = assembleLine({ location, runtime: jl.runtime, env: {} });
    // The stop of a goal limit, a veto or a wall-time stop is the same exit: the stage ends, then onLineEnd runs.
    const leaking = {
      ...line.stations,
      S3: {
        id: "S3" as const,
        run: () => {
          plantOwnedContainer(jl.fake.state, "implementer", THIS_RUN);
          return { kind: "blocked" as const, reason_code: "infra_failure" as const };
        },
      },
    };
    const result = await runLine({
      location,
      workId,
      stations: leaking,
      onLineEnd: line.onLineEnd,
      newRunId: () => THIS_RUN,
    });
    finished(result);
    expect(names(jl)).toEqual([]);
  });
});
