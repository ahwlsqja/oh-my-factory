import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTAINER_PROBE_ARGV,
  MeasureError,
  NotGoldenError,
  createMeasured,
  judgeObserved,
  parseProbe,
} from "../../src/container/measure.js";
import { hostClock, LIFETIME_SLACK_MS, lifetimeElapsed, resetLifecycle } from "../../src/container/lifecycle.js";
import { ROLE_STAGE } from "../../src/container/spec.js";
import type { ContainerRole } from "../../src/container/spec.js";
import { isolationPath } from "../../src/isolation/record.js";
import { RUN, measureFixture } from "../helpers/measure-fixture.js";

afterEach(resetLifecycle);

describe("createMeasured", () => {
  it.each(["sut", "harness", "workcopy"] as const satisfies readonly ContainerRole[])(
    "measures a golden %s container L2 and leaves it running",
    async (role) => {
      const f = await measureFixture();
      const { measurement } = await createMeasured(f.deps, f.spec(role), f.golden(role));
      const stage = ROLE_STAGE[role];
      expect(measurement).toMatchObject({ stage, mode: "container", level: "L2", violations: [] });
      expect(f.lifecycle()).toEqual(["create", "inspect", "start", "exec"]); // facts judged before the start; no rm
      const summary = f.run().stages[stage];
      expect(summary).toMatchObject({ level: "L2", measurements: 1 });
      const file = JSON.parse(readFileSync(isolationPath(f.itemDir, RUN), "utf8")) as {
        stages: Record<string, Array<{ facts_sha256: string }>>;
      };
      expect(file.stages[stage]?.map((entry) => entry.facts_sha256)).toEqual(summary?.facts_sha256s);
    },
  );

  it("records the host time just after docker start returned, for the lifetime check, and only for a container that started", async () => {
    const f = await measureFixture();
    hostClock.now = () => 1000;
    const spec = f.spec("sut");
    const { handle } = await createMeasured(f.deps, spec, f.golden("sut"));
    hostClock.now = () => 1000 + spec.lifetime_s * 1000 - LIFETIME_SLACK_MS - 1;
    expect(lifetimeElapsed(handle)).toBe(false);
    hostClock.now = () => 1000 + spec.lifetime_s * 1000 - LIFETIME_SLACK_MS;
    expect(lifetimeElapsed(handle)).toBe(true);
    // a container refused before it started has no start
    resetLifecycle();
    const refused = await measureFixture();
    const bad = refused.spec("sut");
    await expect(
      createMeasured(refused.deps, bad, { ...refused.golden("sut"), network: "bridge" }),
    ).rejects.toBeInstanceOf(NotGoldenError);
    expect(lifetimeElapsed({ name: bad.name })).toBeNull();
  });

  it("hashes the facts without the clock: two clocks, one hash", async () => {
    const f = await measureFixture();
    const { measurement } = await createMeasured(f.deps, f.spec("sut"), f.golden("sut"));
    const { facts, checks } = measurement;
    if (facts === null || checks === null) throw new Error("a container measurement holds facts and checks");
    const early = judgeObserved("sut", facts, checks, f.golden("sut"), new Date(0));
    const late = judgeObserved("sut", facts, checks, f.golden("sut"), new Date(1_700_000_000_000));
    expect(early.measured_at).not.toBe(late.measured_at);
    expect(early.facts_sha256).toBe(late.facts_sha256);
    expect(early.facts_sha256).toBe(measurement.facts_sha256);
  });
});

describe("the in-container probe", () => {
  it("is a frozen constant argv with no interpolation", () => {
    expect(CONTAINER_PROBE_ARGV).toHaveLength(3);
    expect(CONTAINER_PROBE_ARGV.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(Object.isFrozen(CONTAINER_PROBE_ARGV)).toBe(true);
    const source = readFileSync(new URL("../../src/container/measure.ts", import.meta.url), "utf8");
    const region = source.slice(
      source.indexOf("const PROBE_SCRIPT"),
      source.indexOf("export const CONTAINER_PROBE_ARGV"),
    );
    expect(region).toMatch(/PROBE_SCRIPT = \[/);
    expect(region).not.toMatch(/\$\{|`/);
  });

  it("parses only the fixed grammar", () => {
    expect(parseProbe("vendor:claude\ncred:.aws\ncred:.aws\nsocket:1\nend\n")).toEqual({
      vendor_binaries: ["claude"],
      credential_paths: [".aws"],
      docker_socket_present: true,
    });
    for (const bad of [
      "",
      "end\n",
      "socket:0\n",
      "socket:0\nsocket:1\nend\n",
      "vendor:Claude\nsocket:0\nend\n",
      "hello\nsocket:0\nend\n",
    ]) {
      expect(() => parseProbe(bad), JSON.stringify(bad)).toThrow(MeasureError);
    }
  });
});

describe("a measurement that cannot be made records nothing and removes the container", () => {
  it("for an unparseable inspect document", async () => {
    const f = await measureFixture({ inspectBody: "{}" });
    await expect(createMeasured(f.deps, f.spec("sut"), f.golden("sut"))).rejects.toMatchObject({
      code: "inspect_unparseable",
    });
    expect(f.lifecycle()).toEqual(["create", "inspect", "rm"]);
    expect(f.isolationEvents()).toEqual([]);
    expect(existsSync(isolationPath(f.itemDir, RUN))).toBe(false);
    expect(f.run().stages.sut).toBeNull();
  });

  it.each([
    [
      "a probe that exits non-zero",
      { kind: "exited", status: 1, signal: null, stdout: "", stderr: "x" },
      "probe_failed",
    ],
    ["a probe that times out", { kind: "timeout", stdout: "", stderr: "" }, "probe_failed"],
    ["a probe with no end line", "socket:0\n", "probe_malformed"],
  ] as const)("for %s (harness: the host's image, so the measurement itself failed)", async (_name, probe, code) => {
    const f = await measureFixture({ probe });
    await expect(createMeasured(f.deps, f.spec("harness"), f.golden("harness"))).rejects.toMatchObject({ code });
    expect(f.lifecycle()).toEqual(["create", "inspect", "start", "exec", "rm"]);
    expect(f.isolationEvents()).toEqual([]);
    expect(f.run().stages.harness).toBeNull();
  });

  it.each([
    ["a probe that exits non-zero", { kind: "exited", status: 1, signal: null, stdout: "", stderr: "x" }],
    ["a probe that times out", { kind: "timeout", stdout: "", stderr: "" }],
    ["a probe with no end line", "socket:0\n"],
  ] as const)("for %s (sut: the candidate-built image, so the candidate's failure)", async (_name, probe) => {
    const f = await measureFixture({ probe });
    await expect(createMeasured(f.deps, f.spec("sut"), f.golden("sut"))).rejects.toMatchObject({
      name: "CandidateContainerFailure",
      code: "probe_unanswered",
    });
    expect(f.lifecycle()).toEqual(["create", "inspect", "start", "exec", "inspect", "rm"]);
    expect(f.isolationEvents()).toEqual([]);
    expect(f.run().stages.sut).toBeNull();
  });

  it("NotGoldenError carries the closed codes", () => {
    expect(new NotGoldenError(["privileged", "cap_added"]).violations).toEqual(["privileged", "cap_added"]);
  });
});
