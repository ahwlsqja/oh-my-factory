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
  JUDGE_BEGIN_EXEC_CALLS,
  JUDGE_ROUND_DOCKER_CALLS,
  JUDGE_ROUND_EXEC_CALLS,
  JUDGE_STEP_DOCKER_CALLS,
  JUDGE_STEP_EXEC_CALLS,
  JUDGE_SUT_BOOT_DOCKER_CALLS,
  JUDGE_SUT_END_DOCKER_CALLS,
  WORKCOPY_END_DOCKER_CALLS,
  WORKCOPY_EXEC_DOCKER_CALLS,
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
import { BUILD_TIMEOUT_MS, EXTRACT_TIMEOUT_MS } from "../../src/container/work-copy.js";
import { GATE_DEFAULT_TIMEOUT_MS } from "../../src/gate/run-gates.js";
import { PROVE_TEST_DEFAULT_TIMEOUT_MS } from "../../src/gate/prove-test.js";
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

  it("pins the boot caps and the gate exec cap to the code that sets them", () => {
    expect(WORKCOPY_BOOT_S).toBe((EXTRACT_TIMEOUT_MS + BUILD_TIMEOUT_MS) / 1000);
    expect(WORKCOPY_GATE_EXEC_S * 1000).toBe(GATE_DEFAULT_TIMEOUT_MS);
    expect(WORKCOPY_GATE_EXEC_S * 1000).toBe(PROVE_TEST_DEFAULT_TIMEOUT_MS);
  });

  // The host's timeline, call by call, built from the same per-step and per-SUT call counts the bound is sized from.
  const meta = (calls: number): number => calls * JUDGE_DOCKER_CALL_S;
  function sutTimeline(stepS: number): number {
    let t = JUDGE_PROBE_S;
    for (let n = 0; n < MAX_STEPS; n += 1) {
      t += JUDGE_STEP_EXEC_CALLS * stepS; // step and observe
      t += meta(JUDGE_STEP_DOCKER_CALLS); // isRunning inspect
    }
    return t + meta(JUDGE_SUT_END_DOCKER_CALLS); // stop remove, close remove
  }
  function harnessTimeline(k: number, stepS: number): number {
    let t = JUDGE_ROUND_EXEC_CALLS * stepS + JUDGE_PROBE_S + meta(JUDGE_ROUND_DOCKER_CALLS);
    for (let rep = 0; rep < k; rep += 1) {
      for (let scenario = 0; scenario < MAX_SCENARIOS_PER_SET; scenario += 1) {
        t += JUDGE_BEGIN_EXEC_CALLS * stepS + meta(JUDGE_SUT_BOOT_DOCKER_CALLS) + sutTimeline(stepS);
      }
    }
    return t;
  }
  function workcopyTimeline(): number {
    let t = JUDGE_PROBE_S + WORKCOPY_BOOT_S;
    for (let n = 0; n < WORKCOPY_GATE_EXECS; n += 1) t += WORKCOPY_GATE_EXEC_S + meta(WORKCOPY_EXEC_DOCKER_CALLS);
    return t + meta(WORKCOPY_END_DOCKER_CALLS);
  }
  const bound = (worst: number): number => Math.ceil(JUDGE_SAFETY_FACTOR * worst) + AGENT_LIFETIME_MARGIN_S;

  it("names the counts it sizes from, as the code makes the calls", () => {
    expect([JUDGE_STEP_EXEC_CALLS, JUDGE_STEP_DOCKER_CALLS, JUDGE_SUT_END_DOCKER_CALLS]).toEqual([2, 1, 2]);
    expect([JUDGE_SUT_BOOT_DOCKER_CALLS, JUDGE_BEGIN_EXEC_CALLS]).toEqual([3, 1]);
    expect([JUDGE_ROUND_EXEC_CALLS, JUDGE_ROUND_DOCKER_CALLS]).toEqual([2, 3]);
    expect([WORKCOPY_EXEC_DOCKER_CALLS, WORKCOPY_END_DOCKER_CALLS]).toEqual([1, 1]);
  });

  it("sut: probe + steps x (step, observe, state check) + the two removes, times the factor, and a margin", () => {
    const worst = 15 + 12 * (2 * 10 + 60) + 2 * 60;
    expect(sutTimeline(10)).toBe(worst);
    expect(judgeLifetimeSeconds("sut", judge())).toBe(bound(worst));
    expect(judgeLifetimeSeconds("sut", judge())).toBe(1703);
  });

  it("harness: the whole round worst case, times the safety factor, and a margin", () => {
    const each = 10 + 3 * 60 + (15 + 12 * 80 + 120);
    const worst = 2 * 10 + 15 + 3 * 60 + 3 * 100 * each;
    expect(harnessTimeline(3, 10)).toBe(worst);
    expect(judgeLifetimeSeconds("harness", judge())).toBe(bound(worst));
    expect(judgeLifetimeSeconds("harness", judge())).toBe(578633);
  });

  it("workcopy: the probe, the boot caps, every gate exec at its cap with its state check, and the remove", () => {
    const worst = 15 + 720 + 32 * (600 + 60) + 60;
    expect(workcopyTimeline()).toBe(worst);
    expect(judgeLifetimeSeconds("workcopy", judge())).toBe(bound(worst));
    expect(judgeLifetimeSeconds("workcopy", judge())).toBe(32933);
  });

  it("every role fits its bound at every k and every step cap the schema allows", () => {
    for (let k = 2; k <= 10; k += 1) {
      for (const ms of [1000, 1500, 7000, 10_000, 59_999, 120_000]) {
        const stepS = Math.ceil(ms / 1000);
        const config = judge({ k, step_timeout_ms: ms });
        expect(sutTimeline(stepS)).toBeLessThanOrEqual(judgeLifetimeSeconds("sut", config) ?? 0);
        expect(harnessTimeline(k, stepS)).toBeLessThanOrEqual(judgeLifetimeSeconds("harness", config) ?? 0);
        expect(workcopyTimeline()).toBeLessThanOrEqual(judgeLifetimeSeconds("workcopy", config) ?? 0);
        expect(judgeLifetimeSeconds("harness", config) ?? 0).toBeLessThanOrEqual(2147483647);
      }
    }
  });

  it("moves with the configured step cap and with k, and rounds a step cap up to whole seconds", () => {
    const sutAt = (ms: number) => judgeLifetimeSeconds("sut", judge({ step_timeout_ms: ms })) ?? 0;
    expect(sutAt(20_000)).toBe(bound(sutTimeline(20)));
    expect(sutAt(1500)).toBe(bound(sutTimeline(2)));
    const harness = (k: number) => judgeLifetimeSeconds("harness", judge({ k })) ?? 0;
    const each = harnessTimeline(2, 10) - harnessTimeline(1, 10);
    expect(Math.abs(harness(4) - harness(3) - JUDGE_SAFETY_FACTOR * each)).toBeLessThanOrEqual(1);
    // the work copy runs with its own fixed caps, so the step cap does not move it
    expect(judgeLifetimeSeconds("workcopy", judge({ step_timeout_ms: 99_000 }))).toBe(32933);
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
    ["sut", "1703"],
    ["harness", "578633"],
    ["workcopy", "32933"],
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
    // negative guard first: assertSpec does refuse an unbounded or missing lifetime, so accepting the bounds below means something
    for (const role of JUDGE) {
      expect(() => assertSpec({ ...specFor(role), lifetime_s: 2147483648 })).toThrow(ContainerSpecError);
      expect(() => assertSpec({ ...specFor(role), lifetime_s: 0 })).toThrow(ContainerSpecError);
    }
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
      sut: ["sleep", "1703"],
      harness: ["sleep", "578633"],
      workcopy: ["sleep", "32933"],
    });
  });
});
