import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/core/ledger.js";
import type { LineResult, StationResult } from "../../src/work/sequencer.js";
import type { StationId } from "../../src/work/line-types.js";
import { foldWorkBudget, microUsd, raiseWorkLimit } from "../../src/work/w-budget.js";
import { newRunId, wEvent } from "../../src/work/w-events.js";
import { HUMAN } from "../helpers/decision-fixture.js";
import {
  OK,
  type LineFixture,
  type StationBody,
  fakeGate,
  fillClean,
  finished,
  passGates,
  setupLine,
  stationsOf,
} from "../helpers/line.js";

// Spec 4.4 (loop guards, visit caps) and 5.0 (GATE-4). No model is called: stations and GATE-2/GATE-3 are
// scripted here, GATE-1 is the real one over the closed interface decision of the line fixture.

const hex = (n: number): string => n.toString(16).padStart(64, "0");

/** How many times a node has run so far. The helper stations log their id before their body runs, so inside a body this is "my call number". */
const nth = (log: string[], id: string): number => log.filter((entry) => entry === id).length;

function line(
  f: LineFixture,
  log: string[],
  bodies: Partial<Record<StationId, StationBody>> = {},
): Promise<LineResult> {
  return f.go({ stations: stationsOf(log, bodies), gates: passGates(log) });
}

/** Replaces the `[w]` table of config.toml. Call it before the item's first run: the limit is copied into the ledger then (M3b2-D1). */
function setW(f: LineFixture, w: { max_rounds?: number; max_model_usd?: number }): void {
  const file = join(f.fx.location.dir, "config.toml");
  const kept: string[] = [];
  let inW = false;
  for (const text of readFileSync(file, "utf8").split("\n")) {
    if (/^\[w\]\s*$/.test(text)) {
      inW = true;
      continue;
    }
    if (inW && text.startsWith("[")) inW = false;
    if (!inW) kept.push(text);
  }
  const table = ["[w]"];
  if (w.max_rounds !== undefined) table.push(`max_rounds = ${w.max_rounds}`);
  if (w.max_model_usd !== undefined) table.push(`max_model_usd = ${w.max_model_usd}`);
  writeFileSync(file, `${kept.join("\n").trimEnd()}\n\n${table.join("\n")}\n`);
}

const rework = (digest: string): StationResult => ({ kind: "rework", progress_digest: digest });

/** Round 1 fills every input clean and asks for rework; in round 2 S4 does `second` (by default nothing). */
function reworkOnce(f: LineFixture, log: string[], second: StationBody = () => OK): Promise<LineResult> {
  return line(f, log, {
    S4: (ctx) => {
      if (nth(log, "S4") > 1) return second(ctx);
      fillClean(ctx.inputs);
      return OK;
    },
    S6: () => (nth(log, "S6") === 1 ? rework(hex(1)) : OK),
  });
}

const roundsOf = (f: LineFixture): unknown[][] =>
  f
    .events()
    .filter((event) => event.type === "work.round")
    .map((event) => [event.payload.round, event.payload.prev_signature]);

describe("rework opens a new round", () => {
  it("S6 rework opens round 2 with the previous signature, and round 2 starts from nothing", async () => {
    const f = setupLine();
    const log: string[] = [];
    const result = finished(await reworkOnce(f, log));

    expect(roundsOf(f)).toHaveLength(2);
    expect(roundsOf(f)[0]).toEqual([1, null]);
    expect(roundsOf(f)[1]?.[0]).toBe(2);
    expect(roundsOf(f)[1]?.[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(["S3", "S4", "S6", "S7"].map((id) => nth(log, id))).toEqual([2, 2, 2, 1]);
    // Round 1 was clean and round 2 wrote nothing: the round-1 audit and sealed pass must not carry over (D5).
    expect(result.outcome).toBe("blocked");
    expect(result.reason_code).toBe("evidence_incomplete");
    expect(result.evidence.audit.canary_hits).toBe("not run");
    expect(result.evidence.sealed.train).toBe("not run");
    expect(result.evidence.gates.history.filter((h) => h.gate === "GATE-4").map((h) => h.verdict)).toEqual([
      "pass",
      "pass",
    ]);
    expect(f.stateOf()).toBe("in_progress");
  });

  it("a round that stops early leaves GATE-3 and GATE-4 not visited, although round 1 passed them", async () => {
    const f = setupLine();
    const log: string[] = [];
    const result = finished(await reworkOnce(f, log, () => ({ kind: "blocked", reason_code: "infra_failure" })));

    expect(roundsOf(f)).toHaveLength(2);
    expect(result.reason_code).toBe("infra_failure");
    expect(result.evidence.gates.per_gate).toEqual({
      "GATE-1": "pass",
      "GATE-2": "pass",
      "GATE-3": "not_visited",
      "GATE-4": "not_visited",
    });
    expect(result.evidence.stations).toMatchObject({
      S3: "ok",
      S4: "blocked",
      S5: "not_run",
      S6: "not_run",
      S7: "not_run",
    });
    // The round-1 check stays in the history; the guards that passed at node entry never appear.
    expect(result.evidence.gates.history.map((h) => h.gate)).toEqual(["GATE-1", "GATE-2", "GATE-3", "GATE-4"]);
  });

  it("a rework whose round looks like the one before is a stall: the item fails (J6)", async () => {
    const f = setupLine();
    const log: string[] = [];
    const result = finished(await line(f, log, { S6: () => rework(hex(7)) }));

    expect(result.reason_code).toBe("stalled");
    expect(result.outcome).toBe("flawed");
    expect(result.disposition.action).toBe("fail");
    expect(nth(log, "S3")).toBe(2);
    expect(f.stateOf()).toBe("failed");
    expect(result.evidence.gates.per_gate["GATE-4"]).toBe("fail");
    expect(result.evidence.gates.history.at(-1)).toEqual({ gate: "GATE-4", verdict: "fail", reasons: ["stalled"] });
    expect(result.handoff?.decision_required.j).toBe("J6");
    // 16 node visits over two rounds, 11 nodes: the handoff keeps the last result of each visited node, so it is
    // written (it used to make buildHandoff throw on the schema cap after the evidence was on disk).
    const ran = result.handoff?.ran ?? [];
    expect(ran.length).toBeGreaterThan(0);
    expect(ran.length).toBeLessThanOrEqual(11);
    expect(new Set(ran.map((entry) => entry.node)).size).toBe(ran.length);
    expect(ran.at(-1)).toEqual({ node: "GATE-4", result: "fail" });
  });
});

describe("the S2/GATE-2 loop", () => {
  it("the 4th visit of S2 in round 0 parks the still-ready item: gate2_exhausted, J3, no work.started", async () => {
    const f = setupLine();
    const log: string[] = [];
    const result = finished(
      await f.go({
        stations: stationsOf(log),
        gates: {
          "GATE-2": fakeGate("GATE-2", { log, verdict: "fail", reasons: ["seal_gap"] }),
          "GATE-3": fakeGate("GATE-3", { log }),
        },
      }),
    );

    expect(nth(log, "S2")).toBe(3);
    expect(nth(log, "GATE-2")).toBe(3);
    expect(log).not.toContain("S3");
    expect(result.reason_code).toBe("gate2_exhausted");
    expect(result.outcome).toBe("blocked");
    expect(result.disposition.action).toBe("park");
    expect(f.stateOf()).toBe("ready");
    expect(f.trail()).toEqual(["work.limits_set", "work.parked"]);
    expect(result.evidence.gates.history.at(-1)).toEqual({ gate: "GATE-4", verdict: "fail", reasons: ["visit_cap"] });
    expect(result.handoff?.decision_required.j).toBe("J3");
  });
});

describe("rounds and spend are limits a person can raise (J8)", () => {
  it("rounds exhausted parks; the next entry stops before S1; a raise runs one more round; the counts live in the ledger", async () => {
    const f = setupLine();
    setW(f, { max_rounds: 1 });
    const log: string[] = [];
    const go = (): Promise<LineResult> => line(f, log, { S6: () => (nth(log, "S6") === 1 ? rework(hex(1)) : OK) });

    const first = finished(await go());
    expect(first.reason_code).toBe("budget_exhausted");
    expect(first.disposition.action).toBe("park");
    expect(first.handoff?.decision_required.j).toBe("J8");
    expect(log).not.toContain("S7");
    expect(f.stateOf()).toBe("in_progress");

    const second = finished(await go());
    expect(second.reason_code).toBe("budget_exhausted");
    expect(nth(log, "S1")).toBe(1); // the entry guard stopped it before any station ran
    expect(roundsOf(f)).toHaveLength(1);

    raiseWorkLimit(f.fx.location, f.workId, "rounds", 1, HUMAN);
    const third = finished(await go());
    expect(nth(log, "S1")).toBe(2);
    expect(roundsOf(f).map((round) => round[0])).toEqual([1, 2]);
    expect(third.reason_code).toBe("evidence_incomplete");

    // A new process sees the same counts: they are in the ledger and nowhere else.
    const fresh = foldWorkBudget(new Ledger(f.fx.location.dir).readVerified(), f.workId);
    expect(fresh).toMatchObject({ rounds_started: 2, effective: { max_rounds: 2 } });
  });

  it("spend over the limit stops the line at the next node", async () => {
    const f = setupLine();
    setW(f, { max_model_usd: 1 });
    const log: string[] = [];
    const result = finished(
      await line(f, log, {
        S3: (ctx) => {
          ctx.recordSpend(2_000_000);
          return OK;
        },
      }),
    );

    expect(result.reason_code).toBe("budget_exhausted");
    expect(log).not.toContain("S4");
    const spends = f
      .events()
      .filter((event) => event.type === "work.spend")
      .map((event) => [event.payload.station, event.payload.micro_usd]);
    expect(spends).toEqual([["S3", 2_000_000]]);
    expect(result.evidence.gates.history.at(-1)).toEqual({
      gate: "GATE-4",
      verdict: "fail",
      reasons: ["spend_exhausted"],
    });
  });

  it("spend at the limit before S3 opens no round; the next entry stops before S1; a raise reopens the line", async () => {
    const f = setupLine();
    setW(f, { max_model_usd: 1 });
    const log: string[] = [];
    const go = (): Promise<LineResult> =>
      line(f, log, {
        S2: (ctx) => {
          if (nth(log, "S2") === 1) ctx.recordSpend(1_000_000);
          return OK;
        },
      });

    const first = finished(await go());
    expect(first.reason_code).toBe("budget_exhausted");
    expect(f.trail()).toEqual(["work.limits_set", "work.spend", "work.parked"]); // no work.round, no work.started
    expect(f.stateOf()).toBe("ready");
    expect(first.evidence.gates.history.at(-1)).toEqual({
      gate: "GATE-4",
      verdict: "fail",
      reasons: ["spend_exhausted"],
    });

    const second = finished(await go());
    expect(second.reason_code).toBe("budget_exhausted");
    expect(nth(log, "S1")).toBe(1);

    raiseWorkLimit(f.fx.location, f.workId, "model_micro_usd", microUsd(1), HUMAN);
    finished(await go());
    expect(nth(log, "S1")).toBe(2);
    expect(roundsOf(f)).toHaveLength(1);
  });
});

describe("re-entry loop", () => {
  it("three parks with the same reason stop the next entry at zero cost; a person's act resets the count", async () => {
    const f = setupLine();
    const log: string[] = [];
    const go = (): Promise<LineResult> =>
      line(f, log, {
        S1: (): StationResult => (nth(log, "S1") <= 3 ? { kind: "blocked", reason_code: "infra_failure" } : OK),
      });
    for (let run = 0; run < 3; run += 1) expect(finished(await go()).reason_code).toBe("infra_failure");
    expect(f.stateOf()).toBe("ready");

    const loop = finished(await go());
    expect(loop.reason_code).toBe("reentry_loop");
    expect(loop.disposition.action).toBe("park");
    expect(loop.handoff?.decision_required.j).toBe("J6");
    expect(nth(log, "S1")).toBe(3);

    raiseWorkLimit(f.fx.location, f.workId, "rounds", 1, HUMAN); // any recorded human act on the goal resets the count
    const after = finished(await go());
    expect(nth(log, "S1")).toBe(4);
    expect(after.reason_code).not.toBe("reentry_loop");
  });

  it("three killed runs (claim_reclaimed events) since the last human act stop the next entry before S1", async () => {
    const f = setupLine();
    for (let kill = 0; kill < 3; kill += 1) {
      f.fx.ledger.append(
        wEvent({
          type: "work.claim_reclaimed",
          payload: {
            goal_id: f.fx.goalId,
            work_id: f.workId,
            run_id: newRunId(new Date(), () => `000${kill}`),
            previous_pid: null,
            previous_acquired_at: "",
          },
        }),
      );
    }
    const log: string[] = [];
    const result = finished(await line(f, log));

    expect(result.reason_code).toBe("reentry_loop");
    expect(log).toEqual([]);
    expect(result.disposition.action).toBe("park");
  });
});
