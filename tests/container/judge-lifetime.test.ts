import { describe, expect, it } from "vitest";
import { createArgv } from "../../src/container/argv.js";
import { containerSpecFor } from "../../src/container/golden.js";
import {
  AGENT_LIFETIME_MARGIN_S,
  ContainerSpecError,
  JUDGE_MAX_SCENARIOS,
  JUDGE_MAX_STEPS,
  JUDGE_PROBE_S,
  WORKCOPY_BOOT_S,
  WORKCOPY_GATE_EXECS,
  WORKCOPY_GATE_EXEC_S,
  assertSpec,
  judgeLifetimeSeconds,
  roleLifetimeSeconds,
} from "../../src/container/spec.js";
import { CONFIG_DEFAULTS, type JudgeConfig } from "../../src/core/config.js";
import { MAX_SCENARIOS_PER_SET, MAX_STEPS } from "../../src/scenario/types.js";
import { FIXTURE_RUN_ID, FIXTURE_WORK_ID, SUT_BASE, limitsFor, specFor } from "../helpers/container-fixture.js";
import { FakeDocker } from "../helpers/fake-docker.js";
import { addImage } from "../helpers/fake-docker-core.mjs";
import { HARNESS_BASE } from "../helpers/container-fixture.js";

// The judge roles used to sleep for 2147483647 s (about 68 years): a run killed by SIGKILL left its SUT, harness and work
// copy containers behind for ever. Each now sleeps for a bound sized from the exec caps it serves, like the agent roles.
const JUDGE = ["sut", "harness", "workcopy"] as const;
const judge = (over: Partial<JudgeConfig> = {}) => ({
  kind: "judge" as const,
  judge: { ...CONFIG_DEFAULTS.judge, ...over },
});
const tail = (argv: readonly string[]): string[] => argv.slice(argv.indexOf("--entrypoint"));
const step = (config: JudgeConfig = CONFIG_DEFAULTS.judge): number => Math.ceil(config.step_timeout_ms / 1000);

describe("judge container lifetime", () => {
  it("pins the scenario bounds it is sized from to the scenario module", () => {
    expect(JUDGE_MAX_STEPS).toBe(MAX_STEPS);
    expect(JUDGE_MAX_SCENARIOS).toBe(MAX_SCENARIOS_PER_SET);
  });

  it("sut: one scenario, the probe and every step at its cap, and a margin", () => {
    expect(judgeLifetimeSeconds("sut", judge())).toBe(JUDGE_PROBE_S + MAX_STEPS * step() + AGENT_LIFETIME_MARGIN_S);
    expect(judgeLifetimeSeconds("sut", judge())).toBe(195);
  });

  it("harness: the whole round, load and verdict, begin and observe of every rep and scenario, and a margin", () => {
    const calls = 2 + CONFIG_DEFAULTS.judge.k * MAX_SCENARIOS_PER_SET * (1 + MAX_STEPS);
    expect(judgeLifetimeSeconds("harness", judge())).toBe(JUDGE_PROBE_S + calls * step() + AGENT_LIFETIME_MARGIN_S);
    expect(judgeLifetimeSeconds("harness", judge())).toBe(39095);
  });

  it("workcopy: the probe, the boot caps, the gate execs at their cap, and a margin", () => {
    expect(WORKCOPY_BOOT_S).toBe(120 + 600);
    expect(judgeLifetimeSeconds("workcopy", judge())).toBe(
      JUDGE_PROBE_S + WORKCOPY_BOOT_S + WORKCOPY_GATE_EXECS * WORKCOPY_GATE_EXEC_S + AGENT_LIFETIME_MARGIN_S,
    );
    expect(judgeLifetimeSeconds("workcopy", judge())).toBe(19995);
  });

  it("moves with the configured step cap and with k, and rounds a step cap up to whole seconds", () => {
    expect((judgeLifetimeSeconds("sut", judge({ step_timeout_ms: 20_000 })) ?? 0) - 195).toBe(MAX_STEPS * 10);
    expect(judgeLifetimeSeconds("sut", judge({ step_timeout_ms: 1500 }))).toBe(15 + MAX_STEPS * 2 + 60);
    const harness = (k: number) => judgeLifetimeSeconds("harness", judge({ k })) ?? 0;
    expect(harness(4) - harness(3)).toBe(MAX_SCENARIOS_PER_SET * (1 + MAX_STEPS) * 10);
    // the work copy runs with its own fixed caps, so the step cap does not move it
    expect(judgeLifetimeSeconds("workcopy", judge({ step_timeout_ms: 99_000 }))).toBe(19995);
  });

  it("never exceeds what sleep and assertSpec accept, however large the configured bounds", () => {
    for (const role of JUDGE) {
      const seconds = judgeLifetimeSeconds(role, judge({ k: 1_000_000, step_timeout_ms: 3_600_000 }));
      expect(seconds).toBeLessThanOrEqual(2147483647);
    }
  });

  it("is null for an agent role and refuses limits of another kind", () => {
    expect(judgeLifetimeSeconds("author", limitsFor("author"))).toBeNull();
    expect(judgeLifetimeSeconds("implementer", limitsFor("implementer"))).toBeNull();
    try {
      judgeLifetimeSeconds("sut", limitsFor("author"));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ContainerSpecError);
    }
  });

  it.each([
    ["sut", "195"],
    ["harness", "39095"],
    ["workcopy", "19995"],
  ] as const)("pins the %s entrypoint argv: sleep for its lifetime, never the unbounded sleep", (role, seconds) => {
    const argv = createArgv(specFor(role), "ctx");
    expect(tail(argv)).toEqual(["--entrypoint", "sleep", specFor(role).image, seconds]);
    expect(argv).not.toContain("2147483647");
    expect(argv).not.toContain("timeout");
  });

  it("is built into the spec the stations use, for every role", () => {
    for (const role of JUDGE) {
      const spec = containerSpecFor({
        role,
        image: specFor(role).image,
        labels: { work_id: FIXTURE_WORK_ID, run_id: FIXTURE_RUN_ID, round: 1 },
        serial: 1,
        limits: limitsFor(role),
      });
      expect(spec.lifetime_s).toBe(roleLifetimeSeconds(role, limitsFor(role)));
    }
  });

  it("refuses a judge spec with no lifetime", () => {
    for (const role of JUDGE) {
      const { lifetime_s: _dropped, ...bare } = specFor(role);
      expect(() => assertSpec(bare as never)).toThrow(ContainerSpecError);
    }
  });

  it("reaches the daemon: the docker double records the sleep argument of each judge role", async () => {
    const fake = new FakeDocker();
    addImage(fake.state, SUT_BASE, { env: [] });
    addImage(fake.state, HARNESS_BASE, { env: [] });
    const seen: Record<string, unknown> = {};
    for (const role of JUDGE) {
      const spec = specFor(role);
      const result = await fake.run(createArgv(spec, "fake"), { timeoutMs: 1000, maxOutputBytes: 1_000_000 });
      expect(result).toMatchObject({ kind: "exited", status: 0 });
      const made = fake.state.containers[spec.name] as unknown as { entrypoint: string; cmd: string[] };
      seen[role] = [made.entrypoint, ...made.cmd];
    }
    expect(seen).toEqual({
      sut: ["sleep", "195"],
      harness: ["sleep", "39095"],
      workcopy: ["sleep", "19995"],
    });
  });
});
