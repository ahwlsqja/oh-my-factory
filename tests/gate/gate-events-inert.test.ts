import { describe, expect, it } from "vitest";
import {
  auditCompletedEvent,
  gate3EvaluatedEvent,
  gatesEvaluatedEvent,
  isolationMeasuredEvent,
} from "../../src/gate/events.js";
import {
  baseFixedEvent,
  candidateCheckedEvent,
  publishIntendedEvent,
  sessionCompletedEvent,
} from "../../src/implementer/events.js";
import { judgeRoundEvent } from "../../src/judge/events.js";
import { HEAD_SHA } from "../helpers/audit-diff-fixture.js";
import { cleanAudit, GREEN_LINE, gateRunOf, measurement } from "../helpers/gate3-parts.js";
import { CANDIDATE_FACTS, SESSION_FACTS } from "../helpers/implementer-events.js";
import { setupW } from "../helpers/w-verbs-fixture.js";

// audit.*, gates.*, isolation.* and gate3.* stay inert for the W verifier and the fold. The events here are built by the
// real writers, so their payloads are schema-valid: a verifier that checked them would not be able to skip them as malformed.
describe("gate, audit and isolation events do not touch the W verifier", () => {
  it.each(["omf", "human:dev"])(
    "appending all five valid event types as %s changes no verdict and no verified item",
    (actor) => {
      const fx = setupW();
      const before = { verdict: fx.verdict(), verified: fx.verified() };
      const events = [
        gatesEvaluatedEvent({ ...fx.scope, round: 1 }, gateRunOf(GREEN_LINE, ["fast", "full"])),
        auditCompletedEvent({ ...fx.scope, round: 1 }, cleanAudit(), HEAD_SHA),
        isolationMeasuredEvent(fx.scope, measurement("sut", "L2"), null),
        gate3EvaluatedEvent({ ...fx.scope, round: 1 }, { passed: false, failed: ["canary_hit"], route: "J6" }),
        judgeRoundEvent(
          { ...fx.scope, round: 1 },
          {
            phase: "train",
            candidate_sha: HEAD_SHA,
            k: 3,
            scenarios_total: 2,
            pass: 2,
            fail: 0,
            flaky: 0,
            error: 0,
            contradiction_scenarios: 1,
            contradiction_rejected: 1,
            harness_context_sha256: "1".repeat(64),
            sut_base_digest: `sha256:${"2".repeat(64)}`,
            harness_base_digest: `sha256:${"3".repeat(64)}`,
          },
        ),
      ];
      expect(events.map((event) => event.type)).toEqual([
        "gates.evaluated",
        "audit.completed",
        "isolation.measured",
        "gate3.evaluated",
        "judge.round_completed",
      ]);
      for (const event of events) fx.ledger.append({ ...event, actor });
      expect(fx.ledger.verify()).toMatchObject({ ok: true, count: fx.events().length });
      expect(fx.events().filter((event) => events.some((e) => e.type === event.type))).toHaveLength(5);
      expect({ verdict: fx.verdict(), verified: fx.verified() }).toEqual(before);
    },
  );

  it.each(["omf", "human:dev"])(
    "appending the four implementer event types as %s changes no verdict and no verified item",
    (actor) => {
      const fx = setupW();
      const before = { verdict: fx.verdict(), verified: fx.verified() };
      const sha = "a".repeat(40);
      const events = [
        baseFixedEvent(fx.scope, { base_sha: sha, base_tree_sha: sha }),
        sessionCompletedEvent(fx.scope, SESSION_FACTS),
        publishIntendedEvent(fx.scope, { round: 1, head_sha: sha }),
        candidateCheckedEvent(fx.scope, CANDIDATE_FACTS),
      ];
      for (const event of events) fx.ledger.append({ ...event, actor });
      expect(fx.ledger.verify()).toMatchObject({ ok: true, count: fx.events().length });
      expect(fx.events().filter((event) => event.type.startsWith("implementer."))).toHaveLength(4);
      expect({ verdict: fx.verdict(), verified: fx.verified() }).toEqual(before);
    },
  );
});
