import { describe, expect, it } from "vitest";
import { createContainerScenarioRunner } from "../../src/judge/relay.js";
import type { ScenarioSession, StepInput, StepLimits } from "../../src/scenario/runner.js";
import { type Candidate, exited, RuntimeDouble } from "../helpers/sut-double.js";

const LIMITS: StepLimits = { timeoutMs: 1000, maxOutputBytes: 4096 };
const RUN = ["/work/cli"];
const step = (argv: string[], stdin = ""): StepInput => ({ argv, stdin });

function relay(candidate: Candidate) {
  const double = new RuntimeDouble(candidate);
  const handle = double.open("omf-sut-test-1");
  const released: string[] = [];
  const runner = createContainerScenarioRunner({
    runtime: double,
    run: RUN,
    acquire: async () => ({
      handle,
      release: async () => {
        released.push(handle.name);
        await double.remove(handle);
      },
    }),
  });
  const open = (): Promise<ScenarioSession> => runner.openScenario({ kind: "candidate", handle: "unused" });
  return { double, runner, released, open };
}

describe("container scenario runner", () => {
  it("identifies itself as the one runner that executes candidate code", () => {
    const { runner } = relay(() => exited(""));
    expect(runner.id).toBe("container-relay");
    expect(runner.executes).toBe("candidate");
  });

  it("refuses a fixture target without acquiring a container", async () => {
    const { runner, double } = relay(() => exited(""));
    const session = await runner.openScenario({ kind: "fixture", id: "echo-everything" });
    expect(await session.runStep(step(["x"]), LIMITS)).toEqual({ outcome: "refused", code: "unknown_fixture" });
    expect(double.sutExecs).toEqual([]);
  });

  it("hands argv and stdin to the container as data, in the scenario's scratch directory", async () => {
    const { open, double } = relay(() => exited("ok", 3));
    const session = await open();
    const hostile = ["--privileged", "-v /:/host", "; rm -rf /", "$(id)", "a\nb"];
    const observation = await session.runStep(step(hostile, "in\u0000put"), LIMITS);
    expect(observation).toEqual({ outcome: "exited", exit_code: 3, stdout: "ok" });
    expect(double.sutExecs).toEqual([
      {
        container: "omf-sut-test-1",
        argv: [...RUN, ...hostile],
        stdin: "in\u0000put",
        workdir: "/scratch",
        env: { HOME: "/scratch", TMPDIR: "/scratch", LC_ALL: "C" },
      },
    ]);
  });

  it("scores a timeout and an output limit as a candidate-caused signal and removes the container", async () => {
    for (const kind of ["timeout", "output_limit"] as const) {
      const { open, double } = relay(() => ({ kind, stdout: "", stderr: "" }));
      const session = await open();
      expect(await session.runStep(step(["x"]), LIMITS)).toEqual({ outcome: "signaled", signal: kind });
      expect(double.calls).toContain("remove:omf-sut-test-1");
      // The container is gone, so a later step cannot run anything in it.
      expect(await session.runStep(step(["y"]), LIMITS)).toEqual({ outcome: "signaled", signal: "container_exited" });
      expect(double.sutExecs).toHaveLength(1);
    }
  });

  it("scores invalid UTF-8 as a candidate-caused signal and keeps the container", async () => {
    const { open, double } = relay(() => exited("bad � bytes"));
    const session = await open();
    expect(await session.runStep(step(["x"]), LIMITS)).toEqual({ outcome: "signaled", signal: "invalid_utf8" });
    expect(double.calls).not.toContain("remove:omf-sut-test-1");
  });

  it("separates a runtime fault from a candidate that killed its own container", async () => {
    const fault = relay(() => ({ kind: "error", code: "EIO", message: "client failed" }));
    expect(await (await fault.open()).runStep(step(["x"]), LIMITS)).toEqual({ outcome: "error" });

    const killer = relay(({ state }) => {
      state.dead = true;
      return { kind: "error", code: "EIO", message: "client failed" };
    });
    expect(await (await killer.open()).runStep(step(["x"]), LIMITS)).toEqual({
      outcome: "signaled",
      signal: "container_exited",
    });
  });

  it("keeps a high exit status when the container is still running, and releases once on close", async () => {
    const { open, released } = relay(() => exited("", 126));
    const session = await open();
    expect(await session.runStep(step(["x"]), LIMITS)).toEqual({ outcome: "exited", exit_code: 126, stdout: "" });
    await session.close();
    expect(released).toEqual(["omf-sut-test-1"]);
  });

  it("refuses an empty run argv when the runner is built", () => {
    const double = new RuntimeDouble(() => exited(""));
    expect(() =>
      createContainerScenarioRunner({
        runtime: double,
        run: [],
        acquire: async () => ({ handle: double.open("omf-sut-test-2"), release: async () => {} }),
      }),
    ).toThrow("relay run argv is empty");
  });
});
