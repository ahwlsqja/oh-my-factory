import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runDecideDefer } from "../../src/cli/decide.js";
import { Ledger, type LedgerEvent, type NewEvent } from "../../src/core/ledger.js";
import { needsHumanFile } from "../../src/decision/needs-human.js";
import { claimStatus } from "../../src/work/claim.js";
import { readEvidence, trustedRecommendation } from "../../src/work/evidence.js";
import type { Gate } from "../../src/work/gates.js";
import { handoffFile } from "../../src/work/handoff.js";
import { LINE_ORDER, type StationId } from "../../src/work/line-types.js";
import { type Station, checkedResult, runLine } from "../../src/work/sequencer.js";
import { HUMAN, addOpen, resolveOpen } from "../helpers/decision-fixture.js";
import { plantCanary } from "../helpers/line-fixture.js";
import { PLANTED, cleanStations, finished, passGate, passGates, setupLine, station, stationsOf, textOf } from "../helpers/line.js";

// Spec §5.0, §5.6, §6.3. With always-pass fake gates and clean stations the line ends in a submit; every other
// test takes one thing away from that line and checks the closed result.
describe("runLine, straight line (8a)", () => {
  it("walks the line in order under one claim and one round, then submits for review", async () => {
    const fx = setupLine();
    const seen: string[] = [];

    const result = finished(await runLine(fx.options({ stations: cleanStations({ trace: seen }), gates: passGates(seen) })));

    expect(seen).toEqual(["S1", "S2", "GATE-2", "S3", "S4", "S5", "GATE-3", "S6", "S7"]);
    expect(Object.keys(result.evidence.self_metrics.stage_times).sort()).toEqual([...LINE_ORDER].sort());
    expect(result).toMatchObject({
      outcome: "success",
      reason_code: null,
      disposition: { action: "submit", recommendation: "human_needed" },
      handoff: null,
    });
    // fake gates came in through the options, so the success cannot be merge_recommended (M3b2-D20)
    expect(result.evidence.unverified_areas).toContainEqual({ code: "injected_gate", decision_id: null });
    expect([...result.evidence.gates.injected].sort()).toEqual(["GATE-2", "GATE-3"]);
    expect(fx.workTypes()).toEqual(["work.limits_set", "work.round", "work.started", "work.submitted"]);
    expect(fx.stateOf()).toBe("awaiting_review");
    expect(claimStatus(fx.itemDir).owner).toBeNull();
    expect(readEvidence(fx.itemDir)).toMatchObject({ ok: true, doc: { run_id: result.run_id } });
    expect(trustedRecommendation(fx.itemDir, fx.events(), fx.item().front)).toBe("human_needed");
  });

  it("tells each station the round, whether the item was already started, and the state it entered in", async () => {
    const fx = setupLine();
    const seen: [string, number, boolean, string][] = [];
    const probe = (id: StationId): Station =>
      station(id, (ctx) => {
        seen.push([id, ctx.round, ctx.resumed, ctx.entryState]);
        return { kind: "ok" };
      });

    await runLine(fx.options({ stations: cleanStations({ override: { S1: probe("S1"), S4: probe("S4") } }), gates: passGates() }));

    expect(seen).toEqual([
      ["S1", 0, false, "ready"],
      ["S4", 1, false, "ready"],
    ]);
  });

  it("with the default gates and no seal GATE-2 fails three times and the 4th S2 visit parks the item: gate2_exhausted, J3", async () => {
    const fx = setupLine();
    const seen: string[] = [];

    const result = finished(await runLine(fx.options({ stations: cleanStations({ trace: seen }) })));

    expect(seen.filter((id) => id.startsWith("S"))).toEqual(["S1", "S2", "S2", "S2"]);
    expect(result).toMatchObject({ outcome: "blocked", reason_code: "gate2_exhausted", disposition: { action: "park" } });
    // GATE-4 failed on the visit cap; GATE-3 was never reached
    expect(result.evidence.gates.per_gate).toEqual({
      "GATE-1": "pass",
      "GATE-2": "fail",
      "GATE-3": "not_visited",
      "GATE-4": "fail",
    });
    const gate2 = result.evidence.gates.history.filter((entry) => entry.gate === "GATE-2");
    expect(gate2).toEqual(Array.from({ length: 3 }, () => ({ gate: "GATE-2", verdict: "fail", reasons: ["seal_missing"] })));
    expect(fx.events().filter((event) => event.type === "gate2.evaluated")).toHaveLength(3);
    expect(result.evidence.gates.injected).toEqual([]);
    expect(result.evidence.stations).toMatchObject({ S1: "ok", S2: "ok", S3: "not_run", S7: "not_run" });
    expect(result.handoff).toMatchObject({ outcome: "blocked", reason_code: "gate2_exhausted", decision_required: { j: "J3" } });
    expect(existsSync(handoffFile(fx.itemDir, result.run_id, "outcome"))).toBe(true);
    expect(fx.stateOf()).toBe("ready");
    expect(fx.workTypes()).toEqual(["work.limits_set", "work.parked"]);
  });

  it("a guard refusal at GATE-2 keeps its closed code and ends the line blocked gate_not_run", async () => {
    const fx = setupLine();
    const plant = station("S2", () => {
      plantCanary(fx.fx.repo);
      return { kind: "ok" };
    });

    const result = finished(await runLine(fx.options({ stations: cleanStations({ override: { S2: plant } }) })));

    expect(result.evidence.gates.history).toContainEqual({ gate: "GATE-2", verdict: "not_run", reasons: ["sealed_material_in_repo"] });
    expect(result).toMatchObject({ outcome: "blocked", reason_code: "gate_not_run" });
    expect(result.evidence.gates.per_gate["GATE-2"]).toBe("not_run");
  });

  it("merges gates over the defaults and records only the replaced one as injected", async () => {
    const fx = setupLine();

    const result = finished(await runLine(fx.options({ gates: { "GATE-3": passGate("GATE-3") } })));

    expect(result.evidence.gates.injected).toEqual(["GATE-3"]);
    expect(result.evidence.gates.per_gate["GATE-2"]).toBe("fail");
  });

  it("refuses a GATE-1 key before it touches the claim or the ledger", async () => {
    const fx = setupLine();
    const before = fx.events().length;

    await expect(runLine(fx.options({ gates: { "GATE-1": passGate("GATE-1") } as never }))).rejects.toThrow(TypeError);

    expect(fx.events()).toHaveLength(before);
    expect(claimStatus(fx.itemDir).held).toBe(false);
  });

  it.each([
    ["a throw", () => { throw new Error(PLANTED); }],
    ["a rejection", () => Promise.reject(new Error(PLANTED))],
    ["free text as a reason", () => ({ gate: "GATE-3", verdict: "pass", reasons: [`${PLANTED} with spaces`] })],
    ["another gate's id", () => ({ gate: "GATE-2", verdict: "pass", reasons: [] })],
  ])("turns %s from a gate into not_run gate_error and keeps the text out of every file", async (_name, evaluate) => {
    const fx = setupLine();
    const slow: Gate = {
      id: "GATE-2",
      evaluate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5)); // an async gate is awaited
        return { gate: "GATE-2", verdict: "pass", reasons: [] };
      },
    };
    const bad = { id: "GATE-3", evaluate } as unknown as Gate;

    const result = finished(await runLine(fx.options({ gates: { "GATE-2": slow, "GATE-3": bad } })));

    expect(result).toMatchObject({ outcome: "blocked", reason_code: "gate_not_run" });
    expect(result.evidence.gates.history).toContainEqual({ gate: "GATE-2", verdict: "pass", reasons: [] });
    expect(result.evidence.gates.history).toContainEqual({ gate: "GATE-3", verdict: "not_run", reasons: ["gate_error"] });
    expect(result.evidence.gates.per_gate["GATE-4"]).toBe("not_visited");
    expect(textOf(fx, result)).not.toContain(PLANTED);
  });

  it.each([
    { name: "throws", s4: station("S4", () => { throw new Error(PLANTED); }), status: "error", outcome: "blocked", reason: "station_error", s5: "not_run" },
    { name: "asks for rework outside S6", s4: station("S4", () => ({ kind: "rework" })), status: "error", outcome: "blocked", reason: "station_error", s5: "not_run" },
    { name: "blocks with a code outside the list", s4: station("S4", () => ({ kind: "blocked", reason_code: "made_up" as never })), status: "error", outcome: "blocked", reason: "station_error", s5: "not_run" },
    { name: "blocks with infra_failure", s4: station("S4", () => ({ kind: "blocked", reason_code: "infra_failure" })), status: "blocked", outcome: "blocked", reason: "infra_failure", s5: "not_run" },
    { name: "needs a person", s4: station("S4", () => ({ kind: "manual", reason_code: "manual_required" })), status: "manual", outcome: "manual", reason: "manual_required", s5: "not_run" },
    { name: "is missing", s4: undefined, status: "skipped", outcome: "blocked", reason: "station_skipped", s5: "ok" },
  ])("a station that $name ends the line as $outcome $reason", async ({ s4, status, outcome, reason, s5 }) => {
    const fx = setupLine();
    const stations = cleanStations(s4 === undefined ? { omit: ["S4"] } : { override: { S4: s4 } });

    const result = finished(await runLine(fx.options({ stations, gates: passGates() })));

    expect(result).toMatchObject({ outcome, reason_code: reason });
    expect(result.evidence.stations).toMatchObject({ S4: status, S5: s5 });
    expect(fx.stateOf()).toBe("in_progress");
    expect(textOf(fx, result)).not.toContain(PLANTED);
  });

  describe("GATE-1 only for an item that is still ready (M3b2-D12)", () => {
    const HOUR = 3_600_000;

    /** A ready item whose only open question is a person's deferral that runs out one hour after the fixture clock. */
    function deferred() {
      const fx = setupLine();
      addOpen(fx.f, "d-cache");
      runDecideDefer(
        fx.f.fx.location,
        fx.workId,
        "d-cache",
        {
          owner: "dev",
          reason: "Waiting on the cache benchmark.",
          revisit_trigger: "After the benchmark lands.",
          default: "Keep the current behavior.",
          expires_at: new Date(fx.clock.now().getTime() + HOUR).toISOString(),
        },
        HUMAN,
        fx.clock.now(),
      );
      return fx;
    }

    it("parks a ready item at J2 with no work.started, and a person can still decide", async () => {
      const fx = deferred();
      fx.clock.advance(2 * HOUR);

      const parked = finished(await runLine(fx.options({ gates: passGates() })));

      expect(parked).toMatchObject({ outcome: "blocked", reason_code: "j2_open", disposition: { action: "park" } });
      expect(parked.evidence.gates.per_gate["GATE-1"]).toBe("fail");
      expect(parked.handoff?.decision_required.j).toBe("J2");
      // the node that stopped the line is still in line, as in a killed_predecessor handoff
      expect(parked.handoff?.remaining[0]).toBe("GATE-1");
      expect(parked.handoff?.remaining).toContain("S2");
      expect(parked.handoff?.state).toContain("Next in line: GATE-1.");
      expect(fx.stateOf()).toBe("ready");
      expect(fx.workTypes()).toEqual(["work.limits_set", "work.parked"]);
      expect(existsSync(needsHumanFile(fx.itemDir))).toBe(true);

      resolveOpen(fx.f, "d-cache"); // decide accepts only a ready item with no claim; the line left both true

      const next = finished(await runLine(fx.options({ gates: passGates() })));
      expect(next.outcome).toBe("success");
      expect(fx.workTypes()).toEqual(["work.limits_set", "work.parked", "work.round", "work.started", "work.submitted"]);
      expect(existsSync(needsHumanFile(fx.itemDir))).toBe(false);
    });

    it("does not evaluate GATE-1 again for an item the earlier run already started", async () => {
      const fx = deferred();
      const blockAtS3 = station("S3", () => ({ kind: "blocked", reason_code: "gate_blocked" }));
      const first = finished(await runLine(fx.options({ stations: cleanStations({ override: { S3: blockAtS3 } }), gates: passGates() })));
      expect(first).toMatchObject({ outcome: "blocked", reason_code: "gate_blocked" });
      expect(fx.stateOf()).toBe("in_progress");
      fx.clock.advance(2 * HOUR); // the deferral has run out now

      const seen: [number, boolean, string][] = [];
      const probe = station("S1", (ctx) => {
        seen.push([ctx.round, ctx.resumed, ctx.entryState]);
        return { kind: "ok" };
      });
      const second = finished(await runLine(fx.options({ stations: cleanStations({ override: { S1: probe } }), gates: passGates() })));

      expect(second.evidence.gates.history).toContainEqual({ gate: "GATE-1", verdict: "pass", reasons: ["already_started"] });
      expect(second).toMatchObject({ outcome: "success" });
      expect(second.reason_code).not.toBe("j2_open");
      expect(seen).toEqual([[0, true, "in_progress"]]);
    });
  });

  it.each([
    {
      name: "a parked outcome",
      s4: station("S4", () => ({ kind: "blocked", reason_code: "infra_failure" })),
      expected: [{ type: "work.parked", evidence: true, handoff: true }],
    },
    { name: "a submitted outcome", s4: station("S4"), expected: [{ type: "work.submitted", evidence: true, handoff: false }] },
  ])("writes the evidence, then the handoff, before the finishing event of $name", async ({ s4, expected }) => {
    const fx = setupLine();
    const seen: { type: string; evidence: boolean; handoff: boolean }[] = [];
    // The W verbs (`parkItem`, `submitForReview`, `failItem`) write through `appendWith` -> `appendWithMany`, and
    // `appendWith` never calls `append`. Spy on `appendWithMany`: wrap `build`, record the file state when the event
    // that `build` returns is a finishing one, then let the original run.
    const original = Ledger.prototype.appendWithMany;
    const spy = vi.spyOn(Ledger.prototype, "appendWithMany").mockImplementation(function (this: Ledger, build: (events: LedgerEvent[]) => NewEvent[]) {
      return original.call(this, (events: LedgerEvent[]) => {
        const built = build(events);
        for (const input of built) {
          if (["work.submitted", "work.failed", "work.parked"].includes(input.type)) {
            const dir = join(fx.itemDir, "handoffs");
            seen.push({
              type: input.type,
              evidence: existsSync(join(fx.itemDir, "evidence.json")),
              handoff: existsSync(dir) && readdirSync(dir).length > 0,
            });
          }
        }
        return built;
      });
    });
    try {
      await runLine(fx.options({ stations: cleanStations({ override: { S4: s4 } }), gates: passGates() }));
    } finally {
      spy.mockRestore();
    }
    expect(seen).toEqual(expected);
  });
});

// A GATE-2 that names where the line stops (GATE-2 fail with a stop route) ends the line at once; a plain fail still loops to S2.
describe("runLine, GATE-2 stop routes", () => {
  const gate2 = (log: string[], result: unknown): Gate => ({
    id: "GATE-2",
    evaluate: () => {
      log.push("GATE-2");
      return result as never;
    },
  });
  const ROUTES = [
    { stop: "J2", reason: "j2_open", j: "J2" },
    { stop: "J3", reason: "scenarios_need_review", j: "J3" },
    { stop: "J7", reason: "gate_blocked", j: "J7" },
  ] as const;

  it.each(ROUTES)("a GATE-2 fail with stop $stop ends the line at once as blocked $reason with that J", async ({ stop, reason, j }) => {
    const fx = setupLine();
    const log: string[] = [];
    const result = finished(
      await runLine(
        fx.options({
          stations: stationsOf(log),
          gates: { "GATE-2": gate2(log, { gate: "GATE-2", verdict: "fail", reasons: ["seal_missing"], stop }), "GATE-3": passGate("GATE-3") },
        }),
      ),
    );

    expect(log).toEqual(["S1", "S2", "GATE-2"]);
    expect(result).toMatchObject({ outcome: "blocked", reason_code: reason, disposition: { action: "park" } });
    expect(result.handoff?.decision_required.j).toBe(j);
    expect(result.evidence.gates.history).toContainEqual({ gate: "GATE-2", verdict: "fail", reasons: ["seal_missing"] });
    expect(JSON.stringify(result.evidence.gates.history)).not.toContain('"stop"');
    expect(fx.stateOf()).toBe("ready");
  });

  it("a GATE-2 fail without a stop route still loops, and the 4th S2 visit is blocked gate2_exhausted", async () => {
    const fx = setupLine();
    const log: string[] = [];
    const result = finished(
      await runLine(
        fx.options({
          stations: stationsOf(log),
          gates: { "GATE-2": gate2(log, { gate: "GATE-2", verdict: "fail", reasons: ["seal_gap"] }), "GATE-3": passGate("GATE-3") },
        }),
      ),
    );
    expect(log.filter((id) => id === "S2")).toHaveLength(3);
    expect(result).toMatchObject({ outcome: "blocked", reason_code: "gate2_exhausted" });
  });

  it("a GATE-2 that throws is blocked gate_not_run", async () => {
    const fx = setupLine();
    const boom: Gate = {
      id: "GATE-2",
      evaluate: () => {
        throw new Error(PLANTED);
      },
    };
    const result = finished(await runLine(fx.options({ gates: { "GATE-2": boom, "GATE-3": passGate("GATE-3") } })));
    expect(result).toMatchObject({ outcome: "blocked", reason_code: "gate_not_run" });
    expect(result.evidence.gates.history).toContainEqual({ gate: "GATE-2", verdict: "not_run", reasons: ["gate_error"] });
  });

  it.each([
    ["stop J4 on a GATE-2 fail", { gate: "GATE-2", verdict: "fail", reasons: ["x"], stop: "J4" }],
    ["a non-string stop on a GATE-2 fail", { gate: "GATE-2", verdict: "fail", reasons: ["x"], stop: 3 }],
  ])("%s becomes not_run gate_error", async (_name, raw) => {
    const fx = setupLine();
    const result = finished(await runLine(fx.options({ gates: { "GATE-2": gate2([], raw), "GATE-3": passGate("GATE-3") } })));
    expect(result.evidence.gates.history).toContainEqual({ gate: "GATE-2", verdict: "not_run", reasons: ["gate_error"] });
    expect(result).toMatchObject({ outcome: "blocked", reason_code: "gate_not_run" });
  });

  it("drops a stop on a GATE-2 pass and on GATE-3", async () => {
    const fx = setupLine();
    const gate3: Gate = { id: "GATE-3", evaluate: () => ({ gate: "GATE-3", verdict: "fail", reasons: ["canary_hit"], stop: "J3" }) as never };
    const result = finished(
      await runLine(fx.options({ gates: { "GATE-2": gate2([], { gate: "GATE-2", verdict: "pass", reasons: [], stop: "J3" }), "GATE-3": gate3 } })),
    );
    // GATE-2 passed (stop dropped), GATE-3 failed as an ordinary gate: no gate2_stop row, no J3 scenario route.
    expect(result.reason_code).not.toBe("scenarios_need_review");
    expect(result.evidence.gates.per_gate["GATE-2"]).toBe("pass");
    expect(result.evidence.gates.per_gate["GATE-3"]).toBe("fail");
  });

  it("checkedResult drops a stop on a GATE-3 fail and on a GATE-2 pass, and keeps it on a GATE-2 fail", () => {
    expect(checkedResult("GATE-3", { gate: "GATE-3", verdict: "fail", reasons: ["canary_hit"], stop: "J3" })).not.toHaveProperty("stop");
    expect(checkedResult("GATE-2", { gate: "GATE-2", verdict: "pass", reasons: [], stop: "J3" })).not.toHaveProperty("stop");
    expect(checkedResult("GATE-2", { gate: "GATE-2", verdict: "fail", reasons: ["canary_hit"], stop: "J3" })).toHaveProperty("stop", "J3");
  });
});
