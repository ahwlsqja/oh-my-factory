// covers: S7.isolation-measured
// covers: S7.docker-client-trusted
import { describe, expect, it } from "vitest";
import { NotGoldenError, createMeasured } from "../../src/container/measure.js";
import { DEVIATIONS, measureFixture } from "../helpers/measure-fixture.js";

// A container whose daemon-reported facts differ from its golden is measured L1 with the evaluator's own closed codes.
// The fake builds its inspect document from the create flags it saw, so the golden half (L2, in tests/container/measure.test.ts)
// proves the argv yields golden facts and each deviation bends one field of that document. The real-daemon half is the
// gated G-real-isolation-probe (spec §5.5, §7).
describe("W-inspect-deviation-lowers-level", () => {
  it.each(DEVIATIONS.map((d) => [d.name, d] as const))(
    "%s records L1 with exactly the evaluator's codes",
    async (_name, deviation) => {
      let inspected = 0; // only the first container deviates, so a later golden one shows it never lifts the stage
      const f = await measureFixture({
        inspect: (doc) => {
          inspected += 1;
          if (inspected === 1) deviation.edit(doc);
        },
      });
      await expect(createMeasured(f.deps, f.spec("sut"), f.golden("sut"))).rejects.toBeInstanceOf(NotGoldenError);
      const [event, ...rest] = f.isolationEvents();
      expect(rest).toEqual([]);
      expect(event?.payload).toMatchObject({
        stage: "sut",
        mode: "container",
        level: "L1",
        violations: [...deviation.codes],
      });
      expect(f.run().stages.sut).toMatchObject({ level: "L1", measurements: 1, violations: [...deviation.codes] });
      await createMeasured(f.deps, f.spec("sut", 2), f.golden("sut"));
      expect(f.run().stages.sut).toMatchObject({ level: "L1", measurements: 2 });
    },
  );

  it("a violation only the in-container probe can show lowers the level too", async () => {
    const f = await measureFixture({ probe: "vendor:claude\ncred:.codex\nsocket:1\nend\n" });
    const codes = ["docker_socket_present", "vendor_binary_present", "credential_present"];
    await expect(createMeasured(f.deps, f.spec("harness"), f.golden("harness"))).rejects.toMatchObject({
      violations: codes,
    });
    expect(f.run().stages.harness).toMatchObject({ level: "L1", violations: codes });
  });
});
