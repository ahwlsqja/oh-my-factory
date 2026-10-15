import { existsSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { needsHumanFile } from "../../src/decision/needs-human.js";
import { goalLockFile } from "../../src/goal/goal-lock.js";
import { emptyEvidenceInputs } from "../../src/work/classify.js";
import {
  type Gate,
  type GateContext,
  type GateResult,
  type GateStatus,
  GateBoard,
  REQUIRED_GATES,
  aggregateGates,
  defaultGates,
  gate1,
  injectedGateIds,
  unimplementedGate,
} from "../../src/work/gates.js";
import {
  GATE_IDS,
  type GateId,
  LINE_ORDER,
  NOT_RUN,
  ROUND_SCOPED_GATES,
  ROUND_SCOPED_INPUTS,
  ROUND_SCOPED_STATIONS,
  STATION_IDS,
} from "../../src/work/line-types.js";
import {
  type DecisionFixture,
  NOW,
  addOpen,
  closeInterface,
  resolveOpen,
  setupDecisionItem,
} from "../helpers/decision-fixture.js";

const allPass = (): Record<GateId, GateStatus> => ({
  "GATE-1": "pass",
  "GATE-2": "pass",
  "GATE-3": "pass",
  "GATE-4": "pass",
});

/** A context for a gate that needs no fixture. */
const bareContext = (over: Partial<GateContext> = {}): GateContext =>
  ({ runId: "run-1", round: 0, resumed: false, inputs: emptyEvidenceInputs(), events: [], now: NOW, ...over }) as unknown as GateContext;

/** A context over a real decision fixture, with the events read fresh each time. */
const fixtureContext = (f: DecisionFixture): GateContext => ({
  location: f.fx.location,
  item: f.item,
  events: f.fx.ledger.readVerified(),
  now: NOW,
  runId: "run-1",
  round: 0,
  resumed: false,
  inputs: emptyEvidenceInputs(),
});

describe("line vocabulary", () => {
  it("has one legal order that visits every station and gate once", () => {
    expect(LINE_ORDER).toEqual(["S1", "GATE-1", "S2", "GATE-2", "S3", "S4", "S5", "GATE-3", "S6", "GATE-4", "S7"]);
    expect([...LINE_ORDER].sort()).toEqual([...STATION_IDS, ...GATE_IDS].sort());
  });

  it("scopes GATE-3, GATE-4, S3 to S7 and every input except isolation_level to a round", () => {
    expect(ROUND_SCOPED_GATES).toEqual(["GATE-3", "GATE-4"]);
    expect(ROUND_SCOPED_STATIONS).toEqual(["S3", "S4", "S5", "S6", "S7"]);
    const keys = Object.keys(emptyEvidenceInputs()).filter((key) => key !== "isolation_level");
    expect([...ROUND_SCOPED_INPUTS].sort()).toEqual(keys.sort());
  });

  it("starts every input as not produced, never as a pass", () => {
    const inputs = emptyEvidenceInputs();
    expect(inputs.isolation_level).toBe("unmeasured");
    expect(inputs.audit).toEqual({ canary_hits: NOT_RUN, tests_edited: NOT_RUN, prove_test: NOT_RUN, judge_config_touched: NOT_RUN });
    expect(inputs.sealed).toEqual({ train: NOT_RUN, test: NOT_RUN });
    for (const key of ["high_risk_paths_touched", "noise_check", "gate_line", "plan_summary", "implementer_notes"] as const) {
      expect(inputs[key]).toBe(NOT_RUN);
    }
  });
});

describe("aggregateGates", () => {
  it("passes only when every required gate passed", () => {
    expect(aggregateGates(allPass())).toEqual({ verdict: "pass", per_gate: allPass(), failing: [] });
  });

  // One gate in each non-pass status, for each gate id: the aggregate fails and names exactly that gate.
  for (const id of GATE_IDS) {
    for (const status of ["fail", "not_run", "not_visited"] as const) {
      it(`fails naming ${id} when it is ${status}`, () => {
        const result = aggregateGates({ ...allPass(), [id]: status });
        expect(result.verdict).toBe("fail");
        expect(result.failing).toEqual([id]);
        expect(result.per_gate[id]).toBe(status);
      });
    }
  }

  it("fails an empty board and names all four gates (E7: empty means fail)", () => {
    const result = aggregateGates({});
    expect(result.verdict).toBe("fail");
    expect(result.failing).toEqual([...GATE_IDS]);
    expect(Object.values(result.per_gate)).toEqual(["not_visited", "not_visited", "not_visited", "not_visited"]);
    expect(REQUIRED_GATES).toEqual(GATE_IDS);
  });

  it("looks only at the required gates, and an empty required list is a fail, not a vacuous pass", () => {
    expect(aggregateGates({ "GATE-1": "pass" }, ["GATE-1"]).verdict).toBe("pass");
    expect(aggregateGates(allPass(), []).verdict).toBe("fail");
  });
});

describe("GateBoard", () => {
  it("fails closed when nothing was recorded", () => {
    const board = new GateBoard();
    expect(board.status("GATE-3")).toBe("not_visited");
    expect(board.aggregate().failing).toEqual([...GATE_IDS]);
    expect(board.history()).toEqual([]);
  });

  it("lets the last result per gate win and keeps every result in the history", () => {
    const board = new GateBoard();
    board.record({ gate: "GATE-2", verdict: "fail", reasons: ["scenario_missing"] });
    board.record({ gate: "GATE-2", verdict: "pass", reasons: [] });
    expect(board.status("GATE-2")).toBe("pass");
    expect(board.history().map((r) => [r.gate, r.verdict])).toEqual([
      ["GATE-2", "fail"],
      ["GATE-2", "pass"],
    ]);
  });

  it("startRound resets GATE-3 and GATE-4 but not GATE-1 or GATE-2, and keeps the history", () => {
    const board = new GateBoard();
    for (const gate of GATE_IDS) board.record({ gate, verdict: "pass", reasons: [] });
    board.startRound();
    expect([...GATE_IDS].map((gate) => board.status(gate))).toEqual(["pass", "pass", "not_visited", "not_visited"]);
    expect(board.aggregate().failing).toEqual(["GATE-3", "GATE-4"]);
    expect(board.history()).toHaveLength(4);
  });

  it("stores a malformed result as not_run gate_error instead of letting it read as a pass", () => {
    const board = new GateBoard();
    board.record({ gate: "GATE-2", verdict: "pass", reasons: ["Not A Closed Code"] });
    expect(board.status("GATE-2")).toBe("not_run");
    board.record({ gate: "GATE-3", verdict: "passed" as never, reasons: [] });
    expect(board.status("GATE-3")).toBe("not_run");
    expect(board.history().map((r) => r.reasons)).toEqual([["gate_error"], ["gate_error"]]);
  });

  it("refuses a result for something that is not a gate", () => {
    expect(() => new GateBoard().record({ gate: "S3" as never, verdict: "pass", reasons: [] })).toThrow(TypeError);
  });
});

describe("Gate contract", () => {
  it("lets a gate be async and hands it the run id, the round and whether the run resumed", async () => {
    let seen: string | null = null;
    const gate: Gate = {
      id: "GATE-2",
      async evaluate(ctx) {
        await Promise.resolve();
        seen = `${ctx.runId}/${ctx.round}/${String(ctx.resumed)}`;
        return { gate: "GATE-2", verdict: "pass", reasons: [] };
      },
    };
    const result = await gate.evaluate(bareContext({ runId: "run-9", round: 2, resumed: true }));
    expect(result.verdict).toBe("pass");
    expect(seen).toBe("run-9/2/true");
  });

  it("gives a gate a read-only view of the inputs (checked by the compiler)", () => {
    const ctx = bareContext();
    const probe = (): void => {
      // @ts-expect-error inputs are read-only for a gate
      ctx.inputs.plan_summary = "changed";
      // @ts-expect-error and so are the nested objects
      ctx.inputs.audit.canary_hits = 1;
    };
    expect(typeof probe).toBe("function");
  });
});

describe("gate1 (the real adapter)", () => {
  it("passes a settled item and leaves no needs-human.json", async () => {
    const f = setupDecisionItem();
    closeInterface(f);
    expect(await gate1().evaluate(fixtureContext(f))).toEqual({ gate: "GATE-1", verdict: "pass", reasons: [] });
    expect(existsSync(needsHumanFile(f.item.dir))).toBe(false);
  });

  it("fails an open decision with j2_open, persists needs-human.json, and clears it once the decision is closed", async () => {
    const f = setupDecisionItem();
    closeInterface(f);
    addOpen(f, "d-cache");
    expect(await gate1().evaluate(fixtureContext(f))).toEqual({ gate: "GATE-1", verdict: "fail", reasons: ["j2_open"] });
    expect(existsSync(needsHumanFile(f.item.dir))).toBe(true);

    resolveOpen(f, "d-cache");
    expect((await gate1().evaluate(fixtureContext(f))).verdict).toBe("pass");
    expect(existsSync(needsHumanFile(f.item.dir))).toBe(false);
  });

  it("is not_run gate_error when the goal lock is missing, and the message is dropped", async () => {
    const f = setupDecisionItem();
    closeInterface(f);
    rmSync(goalLockFile(f.fx.location.dir, f.fx.goalId));
    expect(await gate1().evaluate(fixtureContext(f))).toEqual({ gate: "GATE-1", verdict: "not_run", reasons: ["gate_error"] });
  });
});

describe("default gates", () => {
  it("the unimplemented gate is not_run not_implemented", async () => {
    for (const id of ["GATE-2", "GATE-3"] as const) {
      expect(await unimplementedGate(id).evaluate(bareContext())).toEqual({ gate: id, verdict: "not_run", reasons: ["not_implemented"] });
    }
  });

  it("registers GATE-1 and GATE-2 real and GATE-3 unimplemented, each under its own id", async () => {
    const gates = defaultGates();
    expect(Object.keys(gates).sort()).toEqual(["GATE-1", "GATE-2", "GATE-3"]);
    for (const [key, gate] of Object.entries(gates)) expect(gate.id).toBe(key);
    // GATE-2 is the real gate, not the placeholder: it does not answer not_implemented (the real one needs a real item, so it is only registered here).
    expect(gates["GATE-2"].evaluate.toString()).not.toBe(unimplementedGate("GATE-2").evaluate.toString());
    expect(await gates["GATE-3"].evaluate(bareContext())).toEqual({ gate: "GATE-3", verdict: "not_run", reasons: ["not_implemented"] });
  });

  it("a GateResult can carry a stop route", () => {
    const result: GateResult = { gate: "GATE-2", verdict: "fail", reasons: ["exposure_exhausted"], stop: "J3" };
    expect(result.stop).toBe("J3");
  });

  it("lists exactly the gates that were replaced, in line order", () => {
    const defaults = defaultGates();
    const stub = (id: "GATE-2" | "GATE-3"): Gate => ({ id, evaluate: () => ({ gate: id, verdict: "pass", reasons: [] }) });
    expect(injectedGateIds({ ...defaults }, defaults)).toEqual([]);
    expect(injectedGateIds({ ...defaults, "GATE-3": stub("GATE-3") }, defaults)).toEqual(["GATE-3"]);
    expect(injectedGateIds({ ...defaults, "GATE-3": stub("GATE-3"), "GATE-2": stub("GATE-2") }, defaults)).toEqual(["GATE-2", "GATE-3"]);
  });
});
