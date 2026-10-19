// covers: F9.unverified-areas-first
// covers: S5.8.evidence-no-pass-by-default
import { describe, expect, it } from "vitest";
import { noiseCheck } from "../../src/feedback/noise.js";
import { noiseCheckField } from "../../src/feedback/test-run.js";
import { setupLine } from "../helpers/line.js";
import { classifyLine, cleanInputs, contextOf, judgeSpy, roundState, slot, stationOf } from "../helpers/s6-fixture.js";

// Owner decision O-1: v0.1 never evaluates variance, so `noise_check` stays an unverified area and
// `merge_recommended` is unreachable. S6 is the only producer of the field.
describe("W-noise-unverified-stays", () => {
  it("leaves noise_check not_evaluated after a clean split, so the best a line can reach is human_needed", async () => {
    const l = setupLine();
    const inputs = cleanInputs();

    await stationOf(l, roundState(), judgeSpy(l).judge, slot()).run(contextOf(l, inputs));

    expect(inputs.noise_check).toBe("not_evaluated");
    expect(inputs.sealed.test).toEqual({ pass: 4, total: 4 });
    const classified = classifyLine(inputs);
    expect(classified).toMatchObject({ outcome: "success", recommendation: "human_needed" });
    expect(classified.unverified_areas).toContainEqual({ code: "noise_check_not_evaluated", decision_id: null });
  });

  it("never produces ok or within_variance, whatever k and the flaky counts are", () => {
    for (const k of [1, 2, 3, 5, 10]) {
      for (const flaky_train of [0, 1]) {
        for (const flaky_test of [null, 0, 2]) {
          const field = noiseCheckField(noiseCheck({ k, flaky_train, flaky_test }));
          expect(field).toBe("not_evaluated");
          const inputs = cleanInputs();
          inputs.sealed.test = { pass: 4, total: 4 };
          inputs.noise_check = field;
          expect(classifyLine(inputs).recommendation).not.toBe("merge_recommended");
        }
      }
    }
  });
});
