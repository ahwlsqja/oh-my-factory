import { createDockerRuntime } from "../../src/container/docker-cli.js";
import type { ContainerHandle, ContainerRuntime } from "../../src/container/runtime.js";
import type { ContainerSpec } from "../../src/container/spec.js";
import type { FakeDocker } from "./fake-docker.js";

/** The real adapter over a FakeDocker: every call goes through the real argv builders and the real parsing. */
export function fakeRuntime(fake: FakeDocker, context: string | null = "fake"): ContainerRuntime {
  return createDockerRuntime({
    context,
    run: fake.run,
    runSync: fake.runSync,
    env: { PATH: "/usr/bin", HOME: "/home/x" },
  });
}

/** A handle for a container the test did not create through the runtime. */
export const handleOf = (spec: ContainerSpec): ContainerHandle => ({
  name: spec.name,
  id: "0".repeat(64),
  role: spec.labels.role,
});
