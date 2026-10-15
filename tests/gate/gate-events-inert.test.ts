import { describe, expect, it } from "vitest";
import { setupW } from "../helpers/w-verbs-fixture.js";

// audit.*, gates.*, isolation.* and gate3.* stay inert for the W verifier and the fold.
describe("gate, audit and isolation events do not touch the W verifier", () => {
  it.each(["omf", "human:dev"])("appending all four event types as %s changes no verdict and no verified item", (actor) => {
    const fx = setupW();
    const before = { verdict: fx.verdict(), verified: fx.verified() };
    for (const type of ["gates.evaluated", "audit.completed", "isolation.measured", "gate3.evaluated"]) {
      fx.ledger.append({ actor, type, payload: { ...fx.scope } });
    }
    expect(fx.ledger.verify()).toMatchObject({ ok: true, count: fx.events().length });
    expect({ verdict: fx.verdict(), verified: fx.verified() }).toEqual(before);
  });
});
