import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type StateStore, createMarkdownStore } from "../../src/adapters/state-markdown.js";
import { claimFile, claimStatus } from "../../src/work/claim.js";
import type { Gate, GateVerdict } from "../../src/work/gates.js";
import { STATION_IDS, type StationId } from "../../src/work/line-types.js";
import type { LineOptions } from "../../src/work/sequencer.js";
import { newRunId } from "../../src/work/w-events.js";
import { OK, type LineFixture, type StationBody, fakeGate, finished, passGates, setupLine, stationsOf } from "../helpers/line.js";

/** Another run's claim: same process, a different acquired_at, so the sequencer finds a claim that is not its own. */
function stealClaim(f: LineFixture): void {
  const owner = claimStatus(f.itemDir).owner;
  if (owner === null) throw new Error("the run holds no claim");
  writeFileSync(claimFile(f.itemDir), JSON.stringify({ ...owner, acquired_at: "stolen" }));
}

/** Works until `breakIt()`, then every read fails: the next store read inside a W verb is a WError("malformed"). */
function breakableStore(f: LineFixture): { store: StateStore; breakIt: () => void } {
  const real = createMarkdownStore(f.fx.location.dir);
  let broken = false;
  const store: StateStore = {
    ...real,
    fetchWorkItemsByIds: (ids) => {
      if (broken) throw new Error("the store went away");
      return real.fetchWorkItemsByIds(ids);
    },
  };
  return {
    store,
    breakIt: () => {
      broken = true;
    },
  };
}

/** A GATE-2 that passes and, on the way, breaks the store: the next node is S3, which opens the round. */
function breakingGate(breakIt: () => void): Gate {
  return {
    id: "GATE-2",
    evaluate: () => {
      breakIt();
      return { gate: "GATE-2", verdict: "pass", reasons: [] };
    },
  };
}

describe("runLine: a recheck that fails ends the run without a trace", () => {
  it("a claim another run took during S1 aborts at GATE-1 and is left alone", async () => {
    const f = setupLine();
    const steal: StationBody = () => {
      stealClaim(f);
      return OK;
    };
    const result = await f.go({ stations: stationsOf([], { S1: steal }), gates: passGates([]) });

    expect(result).toMatchObject({ kind: "aborted", reason: "claim_lost", code: null, wcode: null, at: "GATE-1" });
    expect(f.files()).toEqual([]);
    expect(readFileSync(claimFile(f.itemDir), "utf8")).toContain("stolen"); // never released: it is not ours
  });

  it("a config edit made after beginRun's baseline aborts before work.limits_set is written", async () => {
    const f = setupLine();
    // newRunId runs inside beginRun after the governance baseline was read, so the edit shows up as drift at the first recheck
    const edit = (at: Date): string => {
      appendFileSync(join(f.fx.location.dir, "config.toml"), "\n# edited\n");
      return newRunId(at);
    };
    const result = await f.go({ newRunId: edit, gates: passGates([]) });

    expect(result).toMatchObject({ kind: "aborted", reason: "governance", code: null, wcode: null, at: "S1" });
    expect(f.trail()).toEqual([]);
    expect(claimStatus(f.itemDir).held).toBe(false);
  });
});

interface Source {
  name: string;
  at: "S3" | "finish";
  state: "ready" | "in_progress";
  trail: string[];
  options: (breakIt: () => void) => Partial<LineOptions>;
}

const SOURCES: Source[] = [
  {
    name: "run.start (the round opens, the store cannot be read)",
    at: "S3",
    state: "ready",
    trail: ["work.limits_set", "work.round"],
    options: (breakIt) => ({ gates: { "GATE-2": breakingGate(breakIt), "GATE-3": passGates([])["GATE-3"] as Gate } }),
  },
  {
    name: "run.progress (the handed_off marker)",
    at: "S3",
    state: "in_progress",
    trail: ["work.limits_set", "work.round", "work.started"],
    options: (breakIt) => ({
      stations: stationsOf([], {
        S3: () => {
          breakIt();
          return OK;
        },
      }),
      gates: passGates([]),
    }),
  },
  {
    name: "run.finish (the evidence and handoff just written are taken back)",
    at: "finish",
    state: "in_progress",
    trail: ["work.limits_set", "work.round", "work.started"],
    options: (breakIt) => ({
      stations: stationsOf([], {
        S3: () => {
          breakIt();
          return { kind: "blocked", reason_code: "infra_failure" };
        },
      }),
      gates: passGates([]),
    }),
  },
];

describe("runLine: a call that throws mid-run ends as aborted run_error and takes this run's files back", () => {
  it.each(SOURCES)("$name", async ({ at, state, trail, options }) => {
    const f = setupLine();
    const broken = breakableStore(f);
    const result = await f.go({ store: broken.store, ...options(broken.breakIt) });

    expect(result).toMatchObject({ kind: "aborted", reason: "run_error", code: null, wcode: "malformed", at });
    expect(f.files()).toEqual([]);
    expect(f.trail()).toEqual(trail);
    expect(f.stateOf()).toBe(state);
    expect(claimStatus(f.itemDir).held).toBe(false);
  });

  it("recordSpend that loses the claim aborts even when the station swallows the failure", async () => {
    const f = setupLine();
    // S2 writes no progress marker, so only the swallow-proof flag can notice the lost claim before the next recheck
    const hiding: StationBody = (ctx) => {
      stealClaim(f);
      try {
        ctx.recordSpend(1);
      } catch {
        // a station that hides the failure and carries on
      }
      return OK;
    };
    const result = await f.go({ stations: stationsOf([], { S2: hiding }), gates: passGates([]) });

    expect(result).toMatchObject({ kind: "aborted", reason: "run_error", wcode: "claim_lost", at: "S2" });
    expect(f.trail()).toEqual(["work.limits_set"]); // no work.spend
    expect(readFileSync(claimFile(f.itemDir), "utf8")).toContain("stolen");
  });
});

describe("runLine: progress markers", () => {
  it("are written from S3 on, never before start()", async () => {
    const f = setupLine();
    const seen: Record<string, string> = {};
    const bodies: Partial<Record<StationId, StationBody>> = {};
    for (const id of STATION_IDS) {
      bodies[id] = () => {
        seen[id] = `${f.stateOf()} ${f.fresh().progress.trim()}`.trim();
        return OK;
      };
    }
    await f.go({ stations: stationsOf([], bodies), gates: passGates([]) });

    expect(seen).toEqual({
      S1: "ready",
      S2: "ready",
      S3: "in_progress S3 entered",
      S4: "in_progress S4 entered",
      S5: "in_progress S5 entered",
      S6: "in_progress S6 entered",
      S7: "in_progress S7 entered",
    });
    expect(f.fresh().progress.trim()).toBe("S7 handed_off");
  });
});

/** A clock that moves only when a station says so, so every duration in the evidence is exact. */
function manualClock(startMs: number): { now: () => Date; advance: (ms: number) => void } {
  let at = startMs;
  return {
    now: () => new Date(at),
    advance: (ms) => {
      at += ms;
    },
  };
}

/** Answers with `verdicts` in order, then repeats the last one. */
function sequenceGate(id: "GATE-2" | "GATE-3", verdicts: GateVerdict[]): Gate {
  let call = 0;
  return {
    id,
    evaluate: () => {
      const verdict = verdicts[Math.min(call++, verdicts.length - 1)] ?? "pass";
      return { gate: id, verdict, reasons: verdict === "pass" ? [] : ["scenarios_failed"] };
    },
  };
}

describe("runLine: stage timing", () => {
  it("measures every station and gate visit of a finished line", async () => {
    const f = setupLine();
    const clock = manualClock(Date.now());
    const spend =
      (ms: number): StationBody =>
      () => {
        clock.advance(ms);
        return OK;
      };
    const stations = stationsOf([], { S1: spend(100), S2: spend(200), S3: spend(300), S4: spend(400), S5: spend(500), S6: spend(600), S7: spend(700) });
    const result = finished(await f.go({ stations, gates: passGates([]), now: clock.now }));

    const once = (total_ms: number): { visits: number; total_ms: number } => ({ visits: 1, total_ms });
    expect(result.evidence.self_metrics.stage_times).toEqual({
      S1: once(100),
      "GATE-1": once(0),
      S2: once(200),
      "GATE-2": once(0),
      S3: once(300),
      S4: once(400),
      S5: once(500),
      "GATE-3": once(0),
      S6: once(600),
      "GATE-4": once(0), // a pure check, so it takes no time of its own, but it is a visit
      S7: once(700),
    });
  });

  it("measures a line that stopped, up to and including the node that stopped it", async () => {
    const f = setupLine();
    const clock = manualClock(Date.now());
    const infra: StationBody = () => {
      clock.advance(50);
      return { kind: "blocked", reason_code: "infra_failure" };
    };
    const result = finished(await f.go({ stations: stationsOf([], { S3: infra }), gates: passGates([]), now: clock.now }));

    const times = result.evidence.self_metrics.stage_times;
    expect(times.S3).toEqual({ visits: 1, total_ms: 50 });
    expect(times.S4).toBeUndefined();
  });

  it("counts every visit when GATE-2 sends the walk back to S2", async () => {
    const f = setupLine();
    const clock = manualClock(Date.now());
    const s2: StationBody = () => {
      clock.advance(10);
      return OK;
    };
    const gates = { "GATE-2": sequenceGate("GATE-2", ["fail", "pass"]), "GATE-3": fakeGate("GATE-3") };
    const result = finished(await f.go({ stations: stationsOf([], { S2: s2 }), gates, now: clock.now }));

    const times = result.evidence.self_metrics.stage_times;
    expect(times.S2).toEqual({ visits: 2, total_ms: 20 });
    expect(times["GATE-2"]).toEqual({ visits: 2, total_ms: 0 });
    expect(times.S1).toEqual({ visits: 1, total_ms: 0 });
  });
});
