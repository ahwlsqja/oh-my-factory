import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/core/ledger.js";
import { schemaUrl, validate } from "../../src/core/schema.js";
import { gatesEvaluatedEvent } from "../../src/gate/events.js";
import { MISCONFIGURED_REASONS, evaluateGateLine, formatGateLine, parseGateLine } from "../../src/gate/gate-line.js";
import type { GateRunResult } from "../../src/gate/run-gates.js";
import { makeTempDir } from "../helpers/tmp.js";

const SCOPE = { goal_id: "g-fast", work_id: "w-0123456789ab", run_id: "r-20261014T091500Z-ab12" };

function run(values: { fast: string; full: string; deep: string }, required: Array<"fast" | "full" | "deep">): GateRunResult {
  const v = values as GateRunResult["values"];
  const line = formatGateLine(v);
  return { line, values: v, verdict: evaluateGateLine(parseGateLine(line), required), details: [] };
}

describe("gatesEvaluatedEvent", () => {
  it("builds an omf event whose payload is ids, a line and members of closed lists", () => {
    const event = gatesEvaluatedEvent(SCOPE, run({ fast: "fail", full: "skip", deep: "pass" }, ["fast", "full"]));
    expect(event).toEqual({
      actor: "omf",
      type: "gates.evaluated",
      payload: {
        ...SCOPE,
        line: "OMF_GATES: fast=fail full=skip deep=pass",
        status: "MISCONFIGURED",
        failing: ["fast"],
        misconfigured: ["full"],
        reasons: ["required_skipped"],
      },
    });
    expect(validate("gate-event.schema.json", { type: event.type, payload: event.payload }).ok).toBe(true);
  });

  it("accepts a GREEN result with empty lists", () => {
    const event = gatesEvaluatedEvent(SCOPE, run({ fast: "pass", full: "pass", deep: "skip" }, ["fast", "full"]));
    expect(event.payload).toMatchObject({ status: "GREEN", failing: [], misconfigured: [], reasons: [] });
  });

  it("refuses a line that is not a gate line and an id that is not an id", () => {
    const refused = /invalid gates\.evaluated event/;
    const good = run({ fast: "pass", full: "pass", deep: "pass" }, ["fast"]);
    expect(() => gatesEvaluatedEvent(SCOPE, { ...good, line: "OMF_GATES: fast=maybe full=pass deep=pass" })).toThrow(refused);
    expect(() => gatesEvaluatedEvent(SCOPE, { ...good, line: "free text the gate wrote" })).toThrow(refused);
    expect(() => gatesEvaluatedEvent({ ...SCOPE, run_id: "../x" }, good)).toThrow(refused);
    expect(() => gatesEvaluatedEvent({ ...SCOPE, work_id: "w-1" }, good)).toThrow(refused);
  });

  it("the schema refuses extra keys, unknown members and a missing field", () => {
    const payload = gatesEvaluatedEvent(SCOPE, run({ fast: "pass", full: "pass", deep: "pass" }, ["fast"])).payload;
    const without = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "status"));
    const bad: Array<[string, Record<string, unknown>]> = [
      ["an extra key", { ...payload, note: "free text" }],
      ["an unknown status", { ...payload, status: "AMBER" }],
      ["an unknown gate name", { ...payload, failing: ["quick"] }],
      ["an unknown reason", { ...payload, reasons: ["because"] }],
      ["a missing field", without],
    ];
    for (const [name, candidate] of bad) {
      expect(validate("gate-event.schema.json", { type: "gates.evaluated", payload: candidate }).ok, name).toBe(false);
    }
    expect(validate("gate-event.schema.json", { type: "gates.unknown", payload }).ok).toBe(false);
  });

  it("keeps the schema enums equal to the TypeScript lists", () => {
    const schema = JSON.parse(readFileSync(schemaUrl("gate-event.schema.json"), "utf8")) as {
      $defs: {
        gate_name: { enum: string[] };
        gates_evaluated_payload: { properties: { reasons: { items: { enum: string[] } }; status: { enum: string[] } } };
      };
    };
    expect(schema.$defs.gate_name.enum).toEqual(["fast", "full", "deep"]);
    expect(schema.$defs.gates_evaluated_payload.properties.reasons.items.enum).toEqual([...MISCONFIGURED_REASONS]);
    expect(schema.$defs.gates_evaluated_payload.properties.status.enum).toEqual(["GREEN", "RED", "MISCONFIGURED"]);
  });

  it("appends to a ledger that still verifies", () => {
    const ledger = new Ledger(makeTempDir("omf-gate-event-"), () => new Date("2026-10-14T09:15:00.000Z"));
    const written = ledger.append(gatesEvaluatedEvent(SCOPE, run({ fast: "pass", full: "pass", deep: "skip" }, ["fast", "full"])));
    expect(written).toMatchObject({ seq: 1, actor: "omf", type: "gates.evaluated" });
    expect(ledger.verify()).toMatchObject({ ok: true, count: 1 });
  });
});
