import { describe, expect, it } from "vitest";
import { withEntryCheck } from "../../src/judge/entry-check.js";
import { runLine } from "../../src/work/sequencer.js";
import type { Station, StationResult } from "../../src/work/sequencer.js";
import type { ReasonCode } from "../../src/work/w-events.js";
import {
  SHA_A,
  SHA_B,
  candidateDouble,
  candidateRef,
  consumeTest,
  declareDisclosure,
  stationCtx,
} from "../helpers/judge-seed.js";
import { cleanStations, finished, passGates, station } from "../helpers/line.js";
import { DEFAULT_SPECS, type SealedItem, seedSealedItem } from "../helpers/scenario-fixture.js";
import { fakeClock } from "../helpers/tick.js";

// X-17: the entry check sits at the end of S2, after the seal stands and before GATE-2, so a line that cannot reach its
// test split stops before S3 opens a round (before any model spend, train round or disclosure unit).
async function lineOver(s: SealedItem, trace: string[], head: string | null = SHA_A) {
  const s2 = withEntryCheck(
    station("S2", () => {
      trace.push("S2");
      return { kind: "ok" };
    }),
    { location: s.f.fx.location, candidates: candidateDouble(head === null ? null : candidateRef(head)) },
  );
  return runLine({
    location: s.f.fx.location,
    workId: s.f.workId,
    stations: cleanStations({ trace, override: { S2: s2 } }),
    gates: passGates(),
    now: fakeClock().now,
  });
}

const types = (s: SealedItem): string[] => s.f.fx.ledger.readVerified().map((event) => event.type);

function declared(consume?: { sha: string; complete: boolean }): SealedItem {
  const s = seedSealedItem();
  declareDisclosure(s);
  if (consume !== undefined) consumeTest(s, consume.sha, consume.complete);
  return s;
}

interface Case {
  name: string;
  arrange: () => SealedItem;
  head: string | null;
  code: ReasonCode;
}
const CASES: Case[] = [
  { name: "no declared disclosure budget", arrange: seedSealedItem, head: SHA_A, code: "disclosure_unavailable" },
  {
    name: "a consumed test split with no result",
    arrange: () => declared({ sha: SHA_A, complete: false }),
    head: SHA_A,
    code: "test_run_incomplete",
  },
  {
    name: "a result recorded for another candidate",
    arrange: () => declared({ sha: SHA_A, complete: true }),
    head: SHA_B,
    code: "test_reseal_required",
  },
  {
    name: "a recorded result and an unknown candidate",
    arrange: () => declared({ sha: SHA_A, complete: true }),
    head: null,
    code: "test_reseal_required",
  },
];

describe("W-entry-check-before-round", () => {
  it.each(CASES)("$name ends the line at S2 with no round in the ledger", async ({ arrange, head, code }) => {
    const s = arrange();
    const trace: string[] = [];
    expect(finished(await lineOver(s, trace, head)).reason_code).toBe(code);
    expect(types(s)).not.toContain("work.round");
    expect(types(s)).not.toContain("work.started");
    expect(trace).toEqual(["S1", "S2"]);
  });

  it("lets a standing seal with a declared budget open its round afterwards", async () => {
    const s = declared();
    const trace: string[] = [];
    await lineOver(s, trace);
    expect(trace.slice(0, 3)).toEqual(["S1", "S2", "S3"]);
    expect(types(s).indexOf("seal.completed")).toBeLessThan(types(s).indexOf("work.round"));
  });

  it("does nothing when the inner station did not answer ok, and leaves a missing seal to GATE-2", async () => {
    const run = (s: SealedItem, answer: StationResult) => {
      const candidates = candidateDouble(candidateRef());
      const inner: Station = { id: "S2", run: () => answer };
      return {
        candidates,
        result: withEntryCheck(inner, { location: s.f.fx.location, candidates }).run(stationCtx(s)),
      };
    };
    const stop: StationResult = { kind: "blocked", reason_code: "j2_open" };
    const stopped = run(seedSealedItem(), stop); // no budget: a check would block
    expect(await stopped.result).toEqual(stop);
    expect(stopped.candidates.calls).toBe(0);
    const ok: StationResult = { kind: "ok" };
    expect(await run(seedSealedItem(DEFAULT_SPECS, { seal: false }), ok).result).toEqual(ok);
  });
});
