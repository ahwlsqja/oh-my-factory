import { describe, expect, it } from "vitest";
import { createArgv } from "../../src/container/argv.js";
import { containerSpecFor } from "../../src/container/golden.js";
import {
  AGENT_LIFETIME_MARGIN_S,
  ContainerSpecError,
  JUDGE_MAX_SCENARIOS,
  JUDGE_DOCKER_CALL_S,
  JUDGE_MAX_STEPS,
  JUDGE_PROBE_S,
  JUDGE_SAFETY_FACTOR,
  JUDGE_SUT_DOCKER_CALLS,
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
import { META_MS } from "../../src/container/docker-cli.js";
import { PROBE_TIMEOUT_MS } from "../../src/container/measure.js";
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

  it("derives the probe and the docker call caps from the caps of the code that runs them", () => {
    expect(JUDGE_PROBE_S).toBe(PROBE_TIMEOUT_MS / 1000);
    expect(JUDGE_DOCKER_CALL_S).toBe(META_MS / 1000);
    expect(JUDGE_SAFETY_FACTOR).toBeGreaterThanOrEqual(1.5);
  });

  it("sut: the probe and every step and observe at its cap, times the safety factor, and a margin", () => {
    const worst = JUDGE_PROBE_S + MAX_STEPS * (step() + step());
    expect(judgeLifetimeSeconds("sut", judge())).toBe(Math.ceil(JUDGE_SAFETY_FACTOR * worst) + AGENT_LIFETIME_MARGIN_S);
    expect(judgeLifetimeSeconds("sut", judge())).toBe(443);
  });

  it("harness: the whole round worst case, times the safety factor, and a margin", () => {
    const config = CONFIG_DEFAULTS.judge;
    const each =
      step(config) + JUDGE_PROBE_S + JUDGE_SUT_DOCKER_CALLS * JUDGE_DOCKER_CALL_S + MAX_STEPS * 2 * step(config);
    const worst = 2 * step(config) + JUDGE_PROBE_S + config.k * MAX_SCENARIOS_PER_SET * each;
    expect(judgeLifetimeSeconds("harness", judge())).toBe(
      Math.ceil(JUDGE_SAFETY_FACTOR * worst) + AGENT_LIFETIME_MARGIN_S,
    );
    expect(judgeLifetimeSeconds("harness", judge())).toBe(254363);
  });

  it("workcopy: the counted exec budget, times the safety factor, and a margin", () => {
    expect(WORKCOPY_BOOT_S).toBe(120 + 600);
    const worst = JUDGE_PROBE_S + WORKCOPY_BOOT_S + WORKCOPY_GATE_EXECS * WORKCOPY_GATE_EXEC_S;
    expect(judgeLifetimeSeconds("workcopy", judge())).toBe(
      Math.ceil(JUDGE_SAFETY_FACTOR * worst) + AGENT_LIFETIME_MARGIN_S,
    );
    expect(judgeLifetimeSeconds("workcopy", judge())).toBe(29963);
  });

  it("a round at the maximum caps fits inside the harness bound computed by the same caps", () => {
    const max = { k: 10, step_timeout_ms: 120_000 };
    const stepS = max.step_timeout_ms / 1000;
    // The timeline of the host, call by call, from the caps of the code that makes each call.
    const sutLife = JUDGE_PROBE_S + MAX_STEPS * (stepS + stepS);
    let elapsed = stepS + stepS + JUDGE_PROBE_S; // load, verdict, harness probe
    for (let rep = 0; rep < max.k; rep += 1) {
      for (let scenario = 0; scenario < MAX_SCENARIOS_PER_SET; scenario += 1) {
        elapsed += stepS; // begin
        elapsed += (META_MS / 1000) * 3; // sut create, inspect, start
        elapsed += PROBE_TIMEOUT_MS / 1000; // sut probe
        elapsed += MAX_STEPS * (stepS + stepS); // step and observe
        elapsed += (META_MS / 1000) * 2; // isRunning inspect, remove
      }
    }
    expect(elapsed).toBeLessThanOrEqual(judgeLifetimeSeconds("harness", judge(max)) ?? 0);
    expect(sutLife).toBeLessThanOrEqual(judgeLifetimeSeconds("sut", judge(max)) ?? 0);
    expect(judgeLifetimeSeconds("harness", judge(max)) ?? 0).toBeLessThanOrEqual(2147483647);
  });

  it("moves with the configured step cap and with k, and rounds a step cap up to whole seconds", () => {
    const sutAt = (ms: number) => judgeLifetimeSeconds("sut", judge({ step_timeout_ms: ms })) ?? 0;
    expect(sutAt(20_000)).toBe(Math.ceil(JUDGE_SAFETY_FACTOR * (JUDGE_PROBE_S + MAX_STEPS * 40)) + 60);
    expect(sutAt(1500)).toBe(Math.ceil(JUDGE_SAFETY_FACTOR * (JUDGE_PROBE_S + MAX_STEPS * 4)) + 60);
    const harness = (k: number) => judgeLifetimeSeconds("harness", judge({ k })) ?? 0;
    const each = 10 + JUDGE_PROBE_S + JUDGE_SUT_DOCKER_CALLS * JUDGE_DOCKER_CALL_S + MAX_STEPS * 20;
    expect(Math.abs(harness(4) - harness(3) - JUDGE_SAFETY_FACTOR * MAX_SCENARIOS_PER_SET * each)).toBeLessThanOrEqual(
      1,
    );
    // the work copy runs with its own fixed caps, so the step cap does not move it
    expect(judgeLifetimeSeconds("workcopy", judge({ step_timeout_ms: 99_000 }))).toBe(29963);
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
    ["sut", "443"],
    ["harness", "254363"],
    ["workcopy", "29963"],
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

  it("accepts the lifetime of every judge role at the default and at the maximum caps", () => {
    for (const role of JUDGE) {
      for (const config of [CONFIG_DEFAULTS.judge, { ...CONFIG_DEFAULTS.judge, k: 10, step_timeout_ms: 120_000 }]) {
        const lifetime_s = roleLifetimeSeconds(role, { kind: "judge", judge: config });
        expect(() => assertSpec({ ...specFor(role), lifetime_s })).not.toThrow();
      }
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
      sut: ["sleep", "443"],
      harness: ["sleep", "254363"],
      workcopy: ["sleep", "29963"],
    });
  });
});
