import { beforeEach, describe, expect, it, vi } from "vitest";
import { createArgv } from "../../src/container/argv.js";
import { NotGoldenError } from "../../src/container/measure.js";
import { roleTmpfs } from "../../src/container/spec.js";
import { FAULTS, scenarioVerdict } from "../../src/judge/round.js";
import { judgeConfig, lease, ref, runRound, scenarioOf, stepOf } from "../helpers/judge-fixture.js";
import { measureHook, resetMeasureHook } from "../helpers/measure-mock.js";
import { exited, RuntimeDouble } from "../helpers/sut-double.js";

vi.mock("../../src/container/measure.js", async () => (await import("../helpers/measure-mock.js")).measureMockModule());

beforeEach(resetMeasureHook);

describe("scenarioVerdict", () => {
  it.each([
    [["pass", "pass"], "pass"],
    [["fail", "fail", "fail"], "fail"],
    [["pass", "fail"], "flaky"],
    [["fail", "pass", "pass"], "flaky"],
    [["pass", "error"], "error"],
    [["fail", "error", "pass"], "error"],
    [[], "error"],
  ] as const)("%j is %s", (outcomes, verdict) => {
    expect(scenarioVerdict(outcomes)).toBe(verdict);
  });
});

describe("fault outcomes", () => {
  // The harness (harness/main.mjs judgeStep, pinned in harness-main.test.ts) scores error and refused `error` and everything
  // else that is not a pass, including a signal, a timeout and the output limit, `fail`. The host must read it the same way.
  it("lists exactly the outcomes the harness scores error", () => {
    expect([...FAULTS].sort()).toEqual(["error", "refused"]);
  });

  it.each([
    ["a timeout", { kind: "timeout", stdout: "", stderr: "" }],
    ["the output limit", { kind: "output_limit", stdout: "", stderr: "" }],
  ] as const)("%s from a candidate step is a failing scenario, never a round error", async (_name, result) => {
    const double = new RuntimeDouble(() => result);
    const verdict = await runRound(double, [scenarioOf(1, [stepOf(["a"], 0)])], { k: 1 });
    expect(verdict.tallies.map((tally) => tally.verdict)).toEqual(["fail"]);
  });
});

describe("a SUT container that stops mid-round", () => {
  it("ends the round as round_error, not as a failed step", async () => {
    const double = new RuntimeDouble(({ state }) => {
      state.dead = true;
      return exited("", 1);
    });
    await expect(runRound(double, [scenarioOf(1, [stepOf(["a"], 0)])], { k: 2 })).rejects.toMatchObject({
      name: "JudgeRoundError",
      code: "round_error",
    });
  });
});

describe("runJudgeRound", () => {
  const always0 = () => exited("");

  it.each([2, 3])("runs every scenario k=%i times and counts behavior and canaries apart", async (k) => {
    const double = new RuntimeDouble(always0);
    const verdict = await runRound(
      double,
      [
        scenarioOf(1, [stepOf(["a"], 0)]),
        scenarioOf(2, [stepOf(["b"], 1)]),
        // A contradiction canary: the candidate must fail it. Exit 1 is expected and the candidate exits 0, so it fails.
        scenarioOf(3, [stepOf(["c"], 1)], { kind: "contradiction_canary" }),
        // A canary the candidate passes (exit 0 as expected): not rejected.
        scenarioOf(4, [stepOf(["d"], 0)], { kind: "contradiction_canary" }),
      ],
      { k },
    );
    expect(verdict.k).toBe(k);
    expect(verdict.counts).toEqual({ total: 2, pass: 1, fail: 1, flaky: 0, error: 0 });
    expect(verdict.contradiction).toEqual({ scenarios: 2, rejected: 1 });
    expect(verdict.tallies.map((t) => [t.scenario_ref, t.verdict, t.outcomes.length])).toEqual([
      [ref(1), "pass", k],
      [ref(2), "fail", k],
      [ref(3), "fail", k],
      [ref(4), "pass", k],
    ]);
    expect(double.sutExecs).toHaveLength(4 * k);
    expect(measureHook.measured.filter((m) => m.role === "sut")).toHaveLength(4 * k);
    expect(measureHook.measured.filter((m) => m.role === "harness")).toHaveLength(1);
    expect(verdict).toMatchObject({
      phase: "train",
      candidate_sha: "c".repeat(40),
      harness_context_sha256: "d".repeat(64),
      sut_base_digest: `sha256:${"b".repeat(64)}`,
      harness_base_digest: `sha256:${"c".repeat(64)}`,
    });
  });

  it("measures each container against the golden of its role and removes everything it created", async () => {
    const double = new RuntimeDouble(always0);
    await runRound(double, [scenarioOf(1, [stepOf(["a"], 0)])], { k: 2 });
    const sut = measureHook.measured.find((m) => m.role === "sut");
    const harness = measureHook.measured.find((m) => m.role === "harness");
    expect(sut?.golden.network).toBe("none");
    expect(sut?.golden.allowed_mounts.map((m) => m.destination).sort()).toEqual(["/scratch", "/tmp"]);
    expect(harness?.golden.allowed_mounts.map((m) => m.destination).sort()).toEqual(["/state", "/tmp"]);
    const created = double.specs.map((spec) => spec.name);
    expect(new Set(created).size).toBe(created.length);
    for (const name of created) expect(double.calls).toContain(`remove:${name}`);
    expect(double.specs.every((spec) => spec.labels.round === 1 && spec.labels.run_id === lease().labels.run_id)).toBe(
      true,
    );
    expect(double.specs[0]?.limits).toEqual({
      memory_mb: judgeConfig().memory_mb,
      cpus: judgeConfig().cpus,
      pids: judgeConfig().pids_limit,
    });
  });

  it("creates every container with the tmpfs set and argv of its role, owned by the sandbox user (one source: roleTmpfs)", async () => {
    const double = new RuntimeDouble(always0);
    await runRound(double, [scenarioOf(1, [stepOf(["a"], 0)])], { k: 2 });
    expect(double.specs.length).toBeGreaterThan(1);
    for (const spec of double.specs) {
      const role = spec.labels.role;
      expect(spec.tmpfs).toEqual(roleTmpfs(role, { kind: "judge", judge: judgeConfig() }));
      const argv = createArgv(spec, null);
      expect(argv).toContain(`/tmp:rw,size=${judgeConfig().tmp_tmpfs_mb}m,nosuid,nodev,uid=65532,gid=65532`);
    }
  });

  it("never treats zero scenarios as a pass and creates nothing", async () => {
    const double = new RuntimeDouble(always0);
    await expect(runRound(double, [])).rejects.toMatchObject({ name: "JudgeRoundError", code: "no_scenarios" });
    expect(double.calls).toEqual([]);
  });

  it("refuses a set with a repeated scenario ref or a scenario without steps", async () => {
    const double = new RuntimeDouble(always0);
    const one = scenarioOf(1, [stepOf(["a"], 0)]);
    await expect(runRound(double, [one, one])).rejects.toMatchObject({ code: "set_invalid" });
    await expect(runRound(double, [scenarioOf(2, [])])).rejects.toMatchObject({ code: "set_invalid" });
    expect(double.calls).toEqual([]);
  });

  it("does not run candidate code in a SUT container that is not golden", async () => {
    const double = new RuntimeDouble(always0);
    measureHook.failWith = (role) => (role === "sut" ? new NotGoldenError(["privileged"]) : null);
    const rejected = runRound(double, [scenarioOf(1, [stepOf(["a"], 0)])]);
    await expect(rejected).rejects.toBeInstanceOf(NotGoldenError);
    expect(double.sutExecs).toEqual([]);
    expect(double.calls.some((call) => call.startsWith("exec:sut"))).toBe(false);
    // The harness that was already running is removed by the final sweep.
    const harnessName = double.specs[0]?.name ?? "";
    expect(double.calls.some((call) => call.startsWith("removeAllSync:") && call.includes(harnessName))).toBe(true);
  });

  it("does not load the set into a harness that is not golden", async () => {
    const double = new RuntimeDouble(always0);
    measureHook.failWith = (role) => (role === "harness" ? new NotGoldenError(["host_network"]) : null);
    await expect(runRound(double, [scenarioOf(1, [stepOf(["a"], 0)])])).rejects.toBeInstanceOf(NotGoldenError);
    expect(double.calls.some((call) => call.startsWith("exec:"))).toBe(false);
  });
});
