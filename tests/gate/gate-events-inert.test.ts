import { describe, expect, it } from "vitest";
import {
  auditCompletedEvent,
  gate3EvaluatedEvent,
  gatesEvaluatedEvent,
  isolationMeasuredEvent,
} from "../../src/gate/events.js";
import { HEAD_SHA } from "../helpers/audit-diff-fixture.js";
import { GREEN_LINE, cleanAudit, gateRunOf, measurement } from "../helpers/gate3-parts.js";
import { setupW } from "../helpers/w-verbs-fixture.js";

// audit.*, gates.*, isolation.* and gate3.* stay inert for the W verifier and the fold. The events here are built by the
// real writers, so their payloads are schema-valid: a verifier that checked them would not be able to skip them as malformed.
describe("gate, audit and isolation events do not touch the W verifier", () => {
  it.each(["omf", "human:dev"])(
    "appending all four valid event types as %s changes no verdict and no verified item",
    (actor) => {
      const fx = setupW();
      const before = { verdict: fx.verdict(), verified: fx.verified() };
      const events = [
        gatesEvaluatedEvent({ ...fx.scope, round: 1 }, gateRunOf(GREEN_LINE, ["fast", "full"])),
        auditCompletedEvent({ ...fx.scope, round: 1 }, cleanAudit(), HEAD_SHA),
        isolationMeasuredEvent(fx.scope, measurement("sut", "L2"), null),
        gate3EvaluatedEvent({ ...fx.scope, round: 1 }, { passed: false, failed: ["canary_hit"], route: "J6" }),
      ];
      expect(events.map((event) => event.type)).toEqual([
        "gates.evaluated",
        "audit.completed",
        "isolation.measured",
        "gate3.evaluated",
      ]);
      for (const event of events) fx.ledger.append({ ...event, actor });
      expect(fx.ledger.verify()).toMatchObject({ ok: true, count: fx.events().length });
      expect(fx.events().filter((event) => events.some((e) => e.type === event.type))).toHaveLength(4);
      expect({ verdict: fx.verdict(), verified: fx.verified() }).toEqual(before);
    },
  );
});
