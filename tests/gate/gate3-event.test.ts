import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/core/ledger.js";
import { schemaUrl } from "../../src/core/schema.js";
import { gate3EvaluatedEvent } from "../../src/gate/events.js";
import { GATE3_CONDITIONS, GATE3_ROUTES, type Gate3Result } from "../../src/gate/gate3.js";
import { SCOPE } from "../helpers/gate3-parts.js";
import { makeTempDir } from "../helpers/tmp.js";

const FAILED: Gate3Result = { passed: false, failed: ["canary_hit", "isolation_unmeasured"], route: "J7" };

describe("gate3EvaluatedEvent", () => {
  it("builds an omf event whose payload is ids, a boolean and members of closed lists", () => {
    expect(gate3EvaluatedEvent(SCOPE, FAILED)).toEqual({
      actor: "omf",
      type: "gate3.evaluated",
      payload: { ...SCOPE, passed: false, failed: ["canary_hit", "isolation_unmeasured"], route: "J7" },
    });
    expect(gate3EvaluatedEvent(SCOPE, { passed: true, failed: [], route: "none" }).payload).toMatchObject({ passed: true, failed: [], route: "none" });
  });

  it("refuses a result that contradicts itself and an id that is not an id", () => {
    const refused = /invalid gate3\.evaluated event/;
    expect(() => gate3EvaluatedEvent(SCOPE, { passed: true, failed: ["canary_hit"], route: "none" })).toThrow(refused);
    expect(() => gate3EvaluatedEvent(SCOPE, { passed: false, failed: [], route: "J6" })).toThrow(refused);
    expect(() => gate3EvaluatedEvent(SCOPE, { passed: false, failed: ["canary_hit"], route: "none" })).toThrow(refused);
    expect(() => gate3EvaluatedEvent({ ...SCOPE, run_id: "run-1" }, FAILED)).toThrow(refused);
  });

  it("keeps the schema enums equal to the TypeScript lists", () => {
    const schema = JSON.parse(readFileSync(schemaUrl("gate-event.schema.json"), "utf8")) as {
      $defs: { gate3_evaluated_payload: { properties: { failed: { items: { enum: string[] } }; route: { enum: string[] } } } };
    };
    const props = schema.$defs.gate3_evaluated_payload.properties;
    expect(props.failed.items.enum).toEqual([...GATE3_CONDITIONS]);
    expect(props.route.enum).toEqual([...GATE3_ROUTES]);
  });

  it("appends and the ledger still verifies", () => {
    const ledger = new Ledger(makeTempDir("omf-gate3-event-"), () => new Date("2026-10-12T10:00:00.000Z"));
    const written = ledger.append(gate3EvaluatedEvent(SCOPE, FAILED));
    expect(written).toMatchObject({ seq: 1, actor: "omf", type: "gate3.evaluated" });
    expect(ledger.verify()).toMatchObject({ ok: true, count: 1 });
  });
});
