import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostClock, markHostEnded, resetLifecycle } from "../../src/container/lifecycle.js";
import { createArgv } from "../../src/container/argv.js";
import { NotGoldenError } from "../../src/container/measure.js";
import { JUDGE_MAX_SCENARIOS, JUDGE_MAX_STEPS, roleTmpfs } from "../../src/container/spec.js";
import { FAULTS, scenarioVerdict } from "../../src/judge/round.js";
import { judgeConfig, lease, ref, runRound, scenarioOf, stepOf } from "../helpers/judge-fixture.js";
import { measureHook, resetMeasureHook } from "../helpers/measure-mock.js";
import { statusRows } from "../helpers/status-rows.js";
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
  const roundError = { name: "JudgeRoundError", code: "round_error" };
  const one = [scenarioOf(1, [stepOf(["a"], 0)])];
  afterEach(resetLifecycle);

  it.each(statusRows([1, 125, 137], [125, 137]))(
    "fails the step when the container stopped early on its own (%s)",
    async (_title, status) => {
      const double = new RuntimeDouble(({ state }) => {
        state.dead = true;
        return exited("", status);
      });
      const verdict = await runRound(double, one, { k: 2 });
      expect(verdict.tallies.map((tally) => [tally.verdict, tally.outcomes])).toEqual([["fail", ["fail", "fail"]]]);
      expect(verdict.counts).toMatchObject({ fail: 1, error: 0 });
    },
  );

  it("negative guard: fails the step when the exec client failed and the container stopped early on its own", async () => {
    const double = new RuntimeDouble(({ state }) => {
      state.dead = true;
      return { kind: "error", code: "EIO", message: "client failed" };
    });
    const verdict = await runRound(double, one, { k: 2 });
    expect(verdict.tallies.map((tally) => tally.verdict)).toEqual(["fail"]);
  });

  it("negative guard: fails the step when the memory limit ended the container (State.OOMKilled true)", async () => {
    const double = new RuntimeDouble(({ state, container }) => {
      state.dead = true;
      double.stopState.set(container, { OOMKilled: true, ExitCode: 137 });
      return exited("", 137);
    });
    const verdict = await runRound(double, one, { k: 1 });
    expect(verdict.tallies.map((tally) => tally.verdict)).toEqual(["fail"]);
  });

  it.each(statusRows([1, 125, 137], [1]))(
    "ends the round as round_error when the lifetime had elapsed (%s)",
    async (_title, status) => {
      const double = new RuntimeDouble(({ state }) => {
        state.dead = true;
        hostClock.now = () => 1e12;
        return exited("", status);
      });
      await expect(runRound(double, one, { k: 2 })).rejects.toMatchObject(roundError);
    },
  );

  it("ends the round as round_error when the host removed the container", async () => {
    const double = new RuntimeDouble(({ state, container }) => {
      state.dead = true;
      markHostEnded(container);
      return exited("", 137);
    });
    await expect(runRound(double, one, { k: 2 })).rejects.toMatchObject(roundError);
  });

  it("negative guard: ends the round as round_error when the inspect after a non-zero exit fails", async () => {
    const double = new RuntimeDouble(() => exited("", 1));
    double.failInspect = true;
    await expect(runRound(double, one, { k: 2 })).rejects.toMatchObject(roundError);
  });

  it("ends the round as round_error for an exit with no status, whatever the container state", async () => {
    const double = new RuntimeDouble(() => ({
      kind: "exited",
      status: null,
      signal: "SIGKILL",
      stdout: "",
      stderr: "",
    }));
    await expect(runRound(double, one, { k: 2 })).rejects.toMatchObject(roundError);
  });

  it("negative guard: keeps a non-zero exit from a container that is still running a failed step", async () => {
    const double = new RuntimeDouble(() => exited("", 1));
    const verdict = await runRound(double, one, { k: 2 });
    expect(verdict.tallies.map((tally) => tally.verdict)).toEqual(["fail"]);
  });
});

describe("round caps", () => {
  it("refuses more scenarios than JUDGE_MAX_SCENARIOS", async () => {
    const double = new RuntimeDouble(() => exited(""));
    const scenarios = Array.from({ length: JUDGE_MAX_SCENARIOS + 1 }, (_, n) => scenarioOf(n + 1, [stepOf(["a"], 0)]));
    await expect(runRound(double, scenarios, { k: 1 })).rejects.toMatchObject({ code: "set_invalid" });
    expect(double.calls).toEqual([]);
  });

  it("refuses a scenario with more steps than JUDGE_MAX_STEPS", async () => {
    const double = new RuntimeDouble(() => exited(""));
    const steps = Array.from({ length: JUDGE_MAX_STEPS + 1 }, () => stepOf(["a"], 0));
    await expect(runRound(double, [scenarioOf(1, steps)], { k: 1 })).rejects.toMatchObject({ code: "set_invalid" });
    expect(double.calls).toEqual([]);
  });

  it("negative guard: accepts exactly the caps", async () => {
    const double = new RuntimeDouble(() => exited(""));
    const steps = Array.from({ length: JUDGE_MAX_STEPS }, () => stepOf(["a"], 0));
    const verdict = await runRound(double, [scenarioOf(1, steps)], { k: 1 });
    expect(verdict.tallies).toHaveLength(1);
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
