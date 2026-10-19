import type { ProcessResult } from "../../src/adapters/process-group.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  hostClock,
  LIFETIME_SLACK_MS,
  markHostEnded,
  recordStarted,
  resetLifecycle,
} from "../../src/container/lifecycle.js";
import { createContainerScenarioRunner } from "../../src/judge/relay.js";
import type { ScenarioSession, StepInput, StepLimits } from "../../src/scenario/runner.js";
import { statusRows } from "../helpers/status-rows.js";
import { type Candidate, exited, RuntimeDouble } from "../helpers/sut-double.js";

const LIMITS: StepLimits = { timeoutMs: 1000, maxOutputBytes: 4096 };
const RUN = ["/work/cli"];
const step = (argv: string[], stdin = ""): StepInput => ({ argv, stdin });

const LIFETIME_S = 1703;
afterEach(resetLifecycle);

/** `startedAt` records the container start on the host clock (the real `createMeasured` does it just after `docker start`). */
function relay(candidate: Candidate, options: { startedAt?: number } = {}) {
  const double = new RuntimeDouble(candidate);
  const handle = double.open("omf-sut-test-1");
  if (options.startedAt !== undefined) {
    hostClock.now = () => options.startedAt as number;
    recordStarted(handle, LIFETIME_S);
  }
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

  it("negative guard: an exec client error from a container that is alive is a runtime fault", async () => {
    const alive = relay(() => ({ kind: "error", code: "EIO", message: "client failed" }));
    expect(await (await alive.open()).runStep(step(["x"]), LIMITS)).toEqual({ outcome: "error" });
  });

  it("an exec client error from a container that is gone, with no start recorded, is a runtime fault", async () => {
    const gone = relay(({ state }) => {
      state.dead = true;
      return { kind: "error", code: "EIO", message: "client failed" };
    });
    expect(await (await gone.open()).runStep(step(["x"]), LIMITS)).toEqual({ outcome: "error" });
    expect(gone.double.calls).toContain("remove:omf-sut-test-1");
  });

  it.each(statusRows([1, 125, 137], [1]))(
    "a non-zero exit (%s) from a container that is gone, with no start recorded, is a runtime fault",
    async (_title, status) => {
      const cut = relay(({ state }) => {
        state.dead = true;
        return exited("", status);
      });
      const session = await cut.open();
      expect(await session.runStep(step(["x"]), LIMITS)).toEqual({ outcome: "error" });
      expect(cut.double.calls).toContain("remove:omf-sut-test-1");
      // the container stays gone for the rest of the scenario
      expect(await session.runStep(step(["y"]), LIMITS)).toEqual({ outcome: "signaled", signal: "container_exited" });
    },
  );

  it.each(statusRows([1, 137], [1]))(
    "a failed inspect after a non-zero exit (%s) is a runtime fault",
    async (_title, status) => {
      const blind = relay(() => exited("", status), { startedAt: 0 });
      blind.double.failInspect = true;
      expect(await (await blind.open()).runStep(step(["x"]), LIMITS)).toEqual({ outcome: "error" });
    },
  );

  describe("a container that stopped early on its own is the candidate's doing", () => {
    const ending =
      (answer: (status: number) => ProcessResult, status: number): Candidate =>
      ({ state }) => {
        state.dead = true;
        return answer(status);
      };
    const execError = () => ({ kind: "error", code: "EIO", message: "client failed" }) as const;

    it.each(statusRows([1, 125, 137], [125, 137]))(
      "a non-zero exit (%s) is signaled container_exited, and the container is removed",
      async (_title, status) => {
        const cut = relay(ending(exited.bind(null, ""), status), { startedAt: 0 });
        hostClock.now = () => 60_000; // one minute into a lifetime of 1703 seconds
        const session = await cut.open();
        expect(await session.runStep(step(["x"]), LIMITS)).toEqual({ outcome: "signaled", signal: "container_exited" });
        expect(cut.double.calls).toContain("remove:omf-sut-test-1");
        expect(await session.runStep(step(["y"]), LIMITS)).toEqual({ outcome: "signaled", signal: "container_exited" });
        expect(cut.double.sutExecs).toHaveLength(1);
      },
    );

    it("negative guard: an exec client error is signaled container_exited", async () => {
      const cut = relay(ending(execError, 0), { startedAt: 0 });
      hostClock.now = () => 1000;
      expect(await (await cut.open()).runStep(step(["x"]), LIMITS)).toEqual({
        outcome: "signaled",
        signal: "container_exited",
      });
    });

    it("negative guard: an early stop the memory limit caused (State.OOMKilled true) is signaled container_exited", async () => {
      const cut = relay(ending(exited.bind(null, ""), 137), { startedAt: 0 });
      cut.double.stopState.set("omf-sut-test-1", { OOMKilled: true, ExitCode: 137 });
      hostClock.now = () => 1000;
      expect(await (await cut.open()).runStep(step(["x"]), LIMITS)).toEqual({
        outcome: "signaled",
        signal: "container_exited",
      });
    });
  });

  describe("a container the host ended is infrastructure, whatever the exit status", () => {
    it.each(statusRows([1, 137], [1]))(
      "a stop at the elapsed lifetime (%s) is a runtime fault",
      async (_title, status) => {
        const cut = relay(
          ({ state }) => {
            state.dead = true;
            hostClock.now = () => LIFETIME_S * 1000 - LIFETIME_SLACK_MS;
            return exited("", status);
          },
          { startedAt: 0 },
        );
        expect(await (await cut.open()).runStep(step(["x"]), LIMITS)).toEqual({ outcome: "error" });
      },
    );

    it("negative guard: a stop one millisecond before the elapsed lifetime is still the candidate's", async () => {
      const cut = relay(
        ({ state }) => {
          state.dead = true;
          hostClock.now = () => LIFETIME_S * 1000 - LIFETIME_SLACK_MS - 1;
          return exited("", 137);
        },
        { startedAt: 0 },
      );
      expect(await (await cut.open()).runStep(step(["x"]), LIMITS)).toEqual({
        outcome: "signaled",
        signal: "container_exited",
      });
    });

    it("a container the host removed during the step is a runtime fault", async () => {
      const cut = relay(
        ({ state, container }) => {
          markHostEnded(container); // a cleanup, a sweep or a release removed it
          state.dead = true;
          return exited("", 137);
        },
        { startedAt: 0 },
      );
      expect(await (await cut.open()).runStep(step(["x"]), LIMITS)).toEqual({ outcome: "error" });
    });
  });

  it.each([
    ["running", false],
    ["gone", true],
  ])("an exit with no status is a runtime fault whatever the container state (%s)", async (_state, dead) => {
    const killedClient = relay(
      ({ state }) => {
        state.dead = dead;
        return { kind: "exited", status: null, signal: "SIGKILL", stdout: "", stderr: "" };
      },
      { startedAt: 0 },
    );
    hostClock.now = () => 1000;
    const session = await killedClient.open();
    expect(await session.runStep(step(["x"]), LIMITS)).toEqual({ outcome: "error" });
    expect(await session.runStep(step(["y"]), LIMITS)).toEqual({ outcome: "signaled", signal: "container_exited" });
  });

  it("a non-zero exit from a container that is still running stays the candidate's exit", async () => {
    const { open } = relay(() => exited("", 1));
    expect(await (await open()).runStep(step(["x"]), LIMITS)).toEqual({ outcome: "exited", exit_code: 1, stdout: "" });
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
