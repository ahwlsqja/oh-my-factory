import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { releaseHeld } from "../../src/judge/engine.js";
import { createFeedbackSlot } from "../../src/judge/round-state.js";
import { judgeStations } from "../../src/judge/stations.js";
import { splitDigest } from "../../src/vault/vault.js";
import type { Station, StationResult } from "../../src/work/sequencer.js";
import { FAILS, type Outcome, type OutcomePlan, PASSES, s4Rig } from "../helpers/judge-rig.js";
import { RUN } from "../helpers/judge-seed.js";
import { recordW } from "../helpers/work.js";

/** One pass, one flaky, one fail among the three train behavior scenarios; the canary is rejected as usual. */
const TABLE: Outcome[][] = [[...PASSES], ["pass", "fail", "pass"], [...FAILS]];
const MIXED: OutcomePlan = (scenario, position) =>
  scenario.kind === "contradiction_canary" ? [...FAILS] : (TABLE[position] ?? [...PASSES]);
const digestOf = (result: StationResult): string | undefined =>
  result.kind === "ok" ? result.progress_digest : undefined;

describe("S4", () => {
  it("blocks as infra_failure, and does not throw, when config.toml is malformed", async () => {
    const r = s4Rig({ judge: "[judge\nnot toml" });
    const result = await r.station.run(r.ctx());
    expect(result).toMatchObject({ kind: "blocked", reason_code: "infra_failure" });
  });

  it("fills sealed.train from the tallies (flaky apart), records the round and a host-only tally file", async () => {
    const r = s4Rig({ plan: MIXED });
    const ctx = r.ctx();
    const result = await r.station.run(ctx);
    expect(digestOf(result)).toMatch(/^[0-9a-f]{64}$/);
    expect(ctx.inputs.sealed.train).toEqual({ pass: 1, total: 3, flaky: 1 });
    expect(ctx.inputs.sealed.test).toBe("not run");

    const events = r.s.f.fx.ledger.readVerified().filter((event) => event.type === "judge.round_completed");
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toBe("omf");
    expect(events[0]?.payload).toMatchObject({ phase: "train", round: 1, run_id: RUN, work_id: r.s.f.workId });
    const file = join(r.s.f.item.dir, "runs", RUN, "judge-1-train.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const text = readFileSync(file, "utf8");
    expect(JSON.parse(text).tallies).toHaveLength(4);
    for (const scenario of r.s.scenarios) expect(text).not.toContain(scenario.canary);
  });

  it("gives the same digest for the same judgement and another when a tally changes", async () => {
    const r = s4Rig();
    const first = digestOf(await r.station.run(r.ctx()));
    expect(digestOf(await r.station.run(r.ctx({ round: 2 })))).toBe(first);
    r.engine.plan = MIXED;
    expect(digestOf(await r.station.run(r.ctx({ round: 3 })))).not.toBe(first);
  });

  it("leaves S6 the round state and the image, and lets the image go at the next S4 or at the end", async () => {
    const r = s4Rig();
    await r.station.run(r.ctx());
    const state = r.holder.current();
    expect(state).toMatchObject({ round: 1, candidate_sha: "a".repeat(40), test: null, flawed_signal: false });
    expect(state?.train.counts.total).toBe(3);
    expect(state?.scenarios.map((scenario) => scenario.split)).toContain("test");
    expect(state?.trainDigest).toBe(splitDigest(r.s.scenarios, new Map(), "train"));
    expect(state?.testDigest).toBe(splitDigest(r.s.scenarios, new Map(), "test"));
    expect(r.engine.disposed).toHaveLength(0);

    await r.station.run(r.ctx({ round: 2 }));
    expect(r.engine.disposed).toHaveLength(1); // round 1's image went when round 2 began
    await releaseHeld(r.runtime.runtime, r.engine.engine, r.holder);
    await releaseHeld(r.runtime.runtime, r.engine.engine, r.holder);
    expect(r.engine.disposed).toHaveLength(2);
    expect(r.holder.current()).toBeNull();
  });

  it("sweeps the resources of earlier runs of this item, never the cached harness image or another run", async () => {
    const earlier = "r-20261013T000000Z-0001";
    const other = "r-20261012T000000Z-0009";
    const r = s4Rig({
      owned: {
        [earlier]: [
          { kind: "container", name: `omf-sut-${earlier}-1-3`, run_id: earlier },
          { kind: "image", name: `omf-sut:${earlier}-1`, run_id: earlier },
          { kind: "image", name: "omf-harness:0123456789ab", run_id: earlier },
        ],
        [other]: [{ kind: "container", name: `omf-sut-${other}-1-1`, run_id: other }],
      },
    });
    recordW(r.s.f.fx.ledger, "work.started", r.s.f.item, { run_id: earlier });
    await r.station.run(r.ctx());
    expect(r.runtime.removed).toEqual([`container:omf-sut-${earlier}-1-3`, `image:omf-sut:${earlier}-1`]);
  });
});

describe("judgeStations", () => {
  it("hands out S4, the S2 wrapper and a dispose() that removes the image still held, once", async () => {
    const r = s4Rig();
    const stations = judgeStations({
      location: r.s.f.fx.location,
      runtime: r.runtime.runtime,
      candidates: r.candidates,
      feedback: createFeedbackSlot(),
      engine: r.engine.engine,
    });
    const s2: Station = { id: "S2", run: () => ({ kind: "ok" }) };
    expect([stations.S4.id, stations.withEntryCheck(s2).id]).toEqual(["S4", "S2"]);
    expect((await stations.S4.run(r.ctx())).kind).toBe("ok");
    await stations.dispose();
    await stations.dispose();
    expect(r.engine.disposed).toHaveLength(1);
  });
});
