import { afterEach, describe, expect, it } from "vitest";
import {
  hostClock,
  LIFETIME_SLACK_MS,
  markHostEnded,
  recordStarted,
  resetLifecycle,
} from "../../src/container/lifecycle.js";
import { trackRuntime } from "../../src/judge/state.js";
import { specFor } from "../helpers/container-fixture.js";
import { MemoryRuntime } from "../helpers/memory-runtime.js";
import { containerState, stopCause } from "../../src/container/running.js";
import type { ContainerHandle } from "../../src/container/runtime.js";

const handle: ContainerHandle = { name: "omf-sut-x-1", id: "omf-sut-x-1", role: "sut" };
const answering = (answer: unknown) => ({ inspect: async () => answer });

describe("containerState", () => {
  it("reads the array of one document that docker inspect prints", async () => {
    expect(await containerState(answering([{ State: { Running: true } }]), handle)).toBe("running");
    expect(await containerState(answering([{ State: { Running: false } }]), handle)).toBe("gone");
  });

  it("reads a bare document", async () => {
    expect(await containerState(answering({ State: { Running: true } }), handle)).toBe("running");
  });

  it("reads a failed inspect as unknown, never as gone", async () => {
    const failing = {
      inspect: async () => {
        throw new Error("daemon unreachable");
      },
    };
    expect(await containerState(failing, handle)).toBe("unknown");
  });

  it("reads an answer without a boolean Running as unknown", async () => {
    expect(await containerState(answering([]), handle)).toBe("unknown");
    expect(await containerState(answering(null), handle)).toBe("unknown");
    expect(await containerState(answering({ State: {} }), handle)).toBe("unknown");
    expect(await containerState(answering([{ State: { Running: "true" } }]), handle)).toBe("unknown");
  });
});

describe("stopCause", () => {
  afterEach(resetLifecycle);
  const LIFETIME_S = 1000;
  let n = 0;
  const fresh = (): ContainerHandle => {
    n += 1;
    return { name: `omf-sut-cause-${n}`, id: `omf-sut-cause-${n}`, role: "sut" };
  };
  const stopped = (extra: Record<string, unknown> = {}) => answering([{ State: { Running: false, ...extra } }]);
  const clockAt = (ms: number): void => {
    hostClock.now = () => ms;
  };

  it("says running for a container that runs, whatever the host knows about it", async () => {
    const handle = fresh();
    markHostEnded(handle);
    expect((await stopCause(answering([{ State: { Running: true } }]), handle)).cause).toBe("running");
  });

  it("says candidate for a container that stopped early on its own, with what the daemon reported", async () => {
    const handle = fresh();
    clockAt(0);
    recordStarted(handle, LIFETIME_S);
    clockAt(60_000);
    const finishedAt = "2026-10-20T01:02:03.000000000Z";
    const decision = await stopCause(stopped({ ExitCode: 137, FinishedAt: finishedAt }), handle);
    expect(decision.cause).toBe("candidate");
    expect(decision.evidence).toEqual({ oom_killed: null, exit_code: 137, finished_at: finishedAt });
  });

  it("says candidate for an early stop the memory limit caused (State.OOMKilled true)", async () => {
    const handle = fresh();
    clockAt(0);
    recordStarted(handle, LIFETIME_S);
    clockAt(1000);
    const decision = await stopCause(stopped({ OOMKilled: true, ExitCode: 137 }), handle);
    expect(decision.cause).toBe("candidate");
    expect(decision.evidence?.oom_killed).toBe(true);
  });

  it("says host once the lifetime has elapsed on the host clock, less the slack, and not a millisecond before", async () => {
    const handle = fresh();
    clockAt(10_000);
    recordStarted(handle, LIFETIME_S);
    const limit = 10_000 + LIFETIME_S * 1000 - LIFETIME_SLACK_MS;
    clockAt(limit - 1);
    expect((await stopCause(stopped(), handle)).cause).toBe("candidate");
    clockAt(limit);
    expect((await stopCause(stopped(), handle)).cause).toBe("host");
    clockAt(limit + 600_000);
    expect((await stopCause(stopped({ OOMKilled: true }), handle)).cause).toBe("host");
  });

  it("says host for a container the host removed or stopped, even early in its life", async () => {
    const handle = fresh();
    clockAt(0);
    recordStarted(handle, LIFETIME_S);
    clockAt(1000);
    markHostEnded(handle);
    expect((await stopCause(stopped(), handle)).cause).toBe("host");
  });

  it("says unknown when no start was recorded, and when the daemon does not answer", async () => {
    expect((await stopCause(stopped(), fresh())).cause).toBe("unknown");
    const blind = fresh();
    recordStarted(blind, LIFETIME_S);
    const failing = {
      inspect: async () => {
        throw new Error("daemon unreachable");
      },
    };
    expect((await stopCause(failing, blind)).cause).toBe("unknown");
    expect((await stopCause(answering({ State: {} }), blind)).cause).toBe("unknown");
  });

  it("says unknown, never candidate, for a failed inspect of a container the host removed", async () => {
    const handle = fresh();
    recordStarted(handle, LIFETIME_S);
    markHostEnded(handle);
    const absent = {
      inspect: async () => {
        throw new Error("No such container");
      },
    };
    expect((await stopCause(absent, handle)).cause).toBe("unknown");
  });

  it("says host for a container the tracked runtime removed or the cleanup removed by name", async () => {
    const memory = new MemoryRuntime();
    const tracked = trackRuntime(memory);
    const spec = specFor("sut");
    const first = await tracked.create(spec);
    recordStarted(first, LIFETIME_S);
    clockAt(1000);
    expect((await stopCause(memory, first)).cause).toBe("running");
    await tracked.remove(first);
    expect((await stopCause(memory, first)).cause).toBe("host");

    const second = await tracked.create(specFor("sut", 2));
    recordStarted(second, LIFETIME_S);
    tracked.close();
    expect((await stopCause(memory, second)).cause).toBe("host");
  });
});
