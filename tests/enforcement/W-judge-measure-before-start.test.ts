// covers: S5.5.judge-two-container
import { describe, expect, it } from "vitest";
import { createMeasured } from "../../src/container/measure.js";
import { DEVIATIONS, measureFixture } from "../helpers/measure-fixture.js";

// The SUT image is candidate-built, so its entrypoint and the probe's `sh` must not run in a container whose facts nobody
// has judged. createMeasured judges `docker inspect` BEFORE `start`; a facts violation removes the container unstarted.
// The call log is the proof: no start, no exec.
describe("W-judge-measure-before-start", () => {
  it.each(DEVIATIONS.map((d) => [d.name, d] as const))(
    "%s: create, inspect, remove, and no start or exec",
    async (_name, deviation) => {
      const f = await measureFixture({ inspect: deviation.edit });
      await createMeasured(f.deps, f.spec("sut"), f.golden("sut")).catch(() => undefined);
      expect(f.lifecycle()).toEqual(["create", "inspect", "rm"]);
    },
  );

  it("a violation only the probe can see removes the container after the start", async () => {
    const f = await measureFixture({ probe: "vendor:claude\nsocket:0\nend\n" });
    await createMeasured(f.deps, f.spec("sut"), f.golden("sut")).catch(() => undefined);
    expect(f.lifecycle()).toEqual(["create", "inspect", "start", "exec", "rm"]);
  });
});
