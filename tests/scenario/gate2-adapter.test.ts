import { describe, expect, it } from "vitest";
import { validateDef } from "../../src/core/schema.js";
import { evaluateGate2Step, gate2Outcome } from "../../src/scenario/gate2-adapter.js";
import type { Gate2ReasonCode, Gate2Result, Gate2Route, ScenarioAggregate } from "../../src/scenario/gate2.js";
import type { ScenarioRunner } from "../../src/scenario/runner.js";
import { ledgerEvents } from "../helpers/enforcement-goal.js";
import {
  ROUND1,
  ROUND2,
  gate2Ctx,
  plantCanary,
  sealStored,
  setupLine,
  tamperSet,
  writeYaml,
} from "../helpers/line-fixture.js";

const AGG: ScenarioAggregate = {
  total: 3,
  active: 3,
  retired: 0,
  contaminated: 0,
  behavior: { train: 1, test: 1 },
  contradiction_canary: { train: 1, test: 0 },
};

function fail(route: Gate2Route, ...codes: Gate2ReasonCode[]): Gate2Result {
  return { status: "fail", route, reasons: codes.map((code) => ({ code })), not_run: [], aggregate: AGG };
}

describe("gate2Outcome", () => {
  it.each([
    ["J2", "gate1_not_passing"],
    ["J3", "set_tampered"],
    ["J7", "probe_error"],
  ] as const)("%s ends the line instead of going back to S2 (%s)", (route, code) => {
    expect(gate2Outcome(fail(route, code))).toMatchObject({
      gate: "GATE-2",
      verdict: "fail",
      reasons: [code],
      next: "stop",
      stop_route: route,
      feedback: null,
    });
  });

  it("sends author-quality failures back to S2 with the unlinked decision ids and nothing else", () => {
    const result: Gate2Result = {
      status: "fail",
      route: "back_to_S2",
      reasons: [{ code: "unlinked_decisions", decision_ids: ["d-cache"] }],
      not_run: ["d-latency"],
      aggregate: AGG,
    };
    const outcome = gate2Outcome(result);
    expect(outcome).toMatchObject({ verdict: "fail", next: "back_to_S2", stop_route: null });
    expect(outcome.feedback?.unlinked_decision_ids).toEqual(["d-cache"]);
  });

  it("continues on pass and keeps the quantitative decisions as not_run, never as success", () => {
    const outcome = gate2Outcome({ status: "pass", not_run: ["d-latency"], aggregate: AGG });
    expect(outcome).toMatchObject({
      verdict: "pass",
      next: "continue",
      reasons: [],
      stop_route: null,
      not_run: ["d-latency"],
    });
  });

  it("lists each reason code once", () => {
    expect(gate2Outcome(fail("back_to_S2", "no_active_scenarios", "no_active_scenarios")).reasons).toEqual([
      "no_active_scenarios",
    ]);
  });
});

describe("evaluateGate2Step", () => {
  it("appends one valid gate2.evaluated per evaluation, naming the seal", async () => {
    const l = setupLine();
    const sealId = await sealStored(l, writeYaml(l, "r1.yaml", ROUND1));
    const first = await evaluateGate2Step(gate2Ctx(l));
    expect(first).toMatchObject({ verdict: "fail", next: "back_to_S2" });
    expect(first.feedback?.unlinked_decision_ids).toEqual(["d-cache"]);
    const events = ledgerEvents(l.f.fx, "gate2.evaluated");
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toBe("omf");
    expect(events[0]?.payload).toMatchObject({
      status: "fail",
      route: "back_to_S2",
      seal_id: sealId,
      unlinked_decision_ids: ["d-cache"],
    });
    expect(events[0]?.payload.reason_codes).toContain("unlinked_decisions");
    expect(validateDef("scenario.schema.json", "ev_gate2_evaluated", events[0]?.payload)).toEqual({ ok: true });
    await evaluateGate2Step(gate2Ctx(l));
    expect(ledgerEvents(l.f.fx, "gate2.evaluated")).toHaveLength(2);
  });

  it("stops at J3 when the sealed set was edited after the seal", async () => {
    const l = setupLine();
    const sealId = await sealStored(l, writeYaml(l, "r2.yaml", ROUND2));
    expect(await evaluateGate2Step(gate2Ctx(l))).toMatchObject({
      verdict: "pass",
      next: "continue",
      not_run: ["d-latency"],
    });
    tamperSet(l, sealId);
    expect(await evaluateGate2Step(gate2Ctx(l))).toMatchObject({
      verdict: "fail",
      next: "stop",
      stop_route: "J3",
      reasons: ["set_tampered"],
    });
  });

  it("maps a throw to not_run, stops at J7 and appends nothing", async () => {
    const l = setupLine();
    await sealStored(l, writeYaml(l, "r2.yaml", ROUND2));
    const candidate: ScenarioRunner = {
      id: "candidate-double",
      executes: "candidate",
      openScenario: async () => {
        throw new Error("must not open a session");
      },
    };
    const outcome = await evaluateGate2Step({ ...gate2Ctx(l), runner: candidate });
    expect(outcome).toMatchObject({
      verdict: "not_run",
      reasons: ["gate_error"],
      next: "stop",
      stop_route: "J7",
      result: null,
    });
    expect(ledgerEvents(l.f.fx, "gate2.evaluated")).toHaveLength(0);
  });

  it("reports a guard refusal at the GATE-2 stage under the guard's closed code, like the S2 station", async () => {
    const l = setupLine();
    await sealStored(l, writeYaml(l, "r2.yaml", ROUND2));
    plantCanary(l.f.fx.repo);
    const sealed = await evaluateGate2Step(gate2Ctx(l));
    expect(sealed).toMatchObject({
      verdict: "not_run",
      reasons: ["sealed_material_in_repo"],
      next: "stop",
      stop_route: "J7",
      result: null,
    });
    expect(ledgerEvents(l.f.fx, "gate2.evaluated")).toHaveLength(0);
  });

  it("keeps gate_error for a throw that is not a guard refusal", async () => {
    const l = setupLine();
    await sealStored(l, writeYaml(l, "r2.yaml", ROUND2));
    const outcome = await evaluateGate2Step({
      ...gate2Ctx(l),
      preflight: () => {
        throw new Error("disk");
      },
    });
    expect(outcome.reasons).toEqual(["gate_error"]);
  });
});
