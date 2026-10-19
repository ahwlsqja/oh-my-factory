import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MeasureError, NotGoldenError, createMeasured } from "../../src/container/measure.js";
import { isolationPath } from "../../src/isolation/record.js";
import type { StageMeasurement } from "../../src/isolation/types.js";
import { type MeasureFixture, RUN, measureFixture } from "../helpers/measure-fixture.js";

// A deferred measurement: the caller holds the full judgment of a golden container and records it later, bound to something that
// does not exist yet. Nothing is written by createMeasured itself, and a container that is not golden hands nothing over.
function deferred(f: MeasureFixture, handed: StageMeasurement[]) {
  return {
    runtime: f.deps.runtime,
    now: f.deps.now,
    defer: (measurement: StageMeasurement): void => void handed.push(measurement),
  };
}

function expectNothingRecorded(f: MeasureFixture): void {
  expect(f.isolationEvents()).toEqual([]);
  expect(existsSync(isolationPath(f.itemDir, RUN))).toBe(false);
  expect(f.run().stages.author).toBeNull();
}

describe("createMeasured with a deferred record", () => {
  it("hands the full judgment of a golden container to the callback and records nothing", async () => {
    const f = await measureFixture({ probe: "vendor:codex\nsocket:0\nend\n" });
    const handed: StageMeasurement[] = [];
    const { measurement } = await createMeasured(deferred(f, handed), f.spec("author"), f.golden("author"));
    expect(handed).toEqual([measurement]);
    expect(measurement).toMatchObject({ stage: "author", mode: "container", level: "L2", violations: [] });
    expect(measurement.checks).not.toBeNull();
    expect(f.lifecycle()).toEqual(["create", "inspect", "start", "exec"]);
    expectNothingRecorded(f);
  });

  it("throws NotGoldenError before the container starts and hands nothing over (facts violation)", async () => {
    const f = await measureFixture({}, { imageEnv: ["PATH=/usr/bin", "CODEX_API_KEY=not-a-real-value"] });
    const handed: StageMeasurement[] = [];
    await expect(createMeasured(deferred(f, handed), f.spec("author"), f.golden("author"))).rejects.toBeInstanceOf(
      NotGoldenError,
    );
    expect(handed).toEqual([]);
    expect(f.lifecycle()).toEqual(["create", "inspect", "rm"]);
    expectNothingRecorded(f);
  });

  it("throws NotGoldenError with the codes after the probe and hands nothing over (probe violation)", async () => {
    const f = await measureFixture({ probe: "vendor:claude\nsocket:0\nend\n" });
    const handed: StageMeasurement[] = [];
    await expect(createMeasured(deferred(f, handed), f.spec("author"), f.golden("author"))).rejects.toMatchObject({
      violations: ["vendor_binary_present"],
    });
    expect(handed).toEqual([]);
    expect(f.lifecycle()).toEqual(["create", "inspect", "start", "exec", "rm"]);
    expectNothingRecorded(f);
  });

  it("throws MeasureError for a probe that cannot be read and hands nothing over", async () => {
    const f = await measureFixture({ probe: "socket:0\n" });
    const handed: StageMeasurement[] = [];
    await expect(createMeasured(deferred(f, handed), f.spec("author"), f.golden("author"))).rejects.toBeInstanceOf(
      MeasureError,
    );
    expect(handed).toEqual([]);
    expect(f.lifecycle().at(-1)).toBe("rm");
    expectNothingRecorded(f);
  });

  it("removes the container when the callback itself fails", async () => {
    const f = await measureFixture({ probe: "vendor:codex\nsocket:0\nend\n" });
    const failing = {
      runtime: f.deps.runtime,
      now: f.deps.now,
      defer: (): void => {
        throw new Error("the record failed");
      },
    };
    await expect(createMeasured(failing, f.spec("author"), f.golden("author"))).rejects.toThrow("the record failed");
    expect(f.lifecycle().at(-1)).toBe("rm");
  });
});
