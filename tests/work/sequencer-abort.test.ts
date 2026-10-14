import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type StateStore, createMarkdownStore } from "../../src/adapters/state-markdown.js";
import { claimFile, claimStatus } from "../../src/work/claim.js";
import type { Gate } from "../../src/work/gates.js";
import { STATION_IDS, type StationId } from "../../src/work/line-types.js";
import type { LineOptions } from "../../src/work/sequencer.js";
import { newRunId } from "../../src/work/w-events.js";
import { OK, type LineFixture, type StationBody, passGates, setupLine, stationsOf } from "../helpers/line.js";

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
