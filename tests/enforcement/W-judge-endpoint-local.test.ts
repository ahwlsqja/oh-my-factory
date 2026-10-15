import { describe, expect, it } from "vitest";
import { pinnedImage } from "../../src/container/image-ref.js";
import { type ContainerRuntime, RuntimeError } from "../../src/container/runtime.js";
import { SUT_BASE, labelsFor, specFor } from "../helpers/container-fixture.js";
import { FakeDocker, MUTATING_VERBS } from "../helpers/fake-docker.js";
import { fakeRuntime, handleOf } from "../helpers/fake-runtime.js";

// W-judge-endpoint-local (spec §7, M3f-D3): untrusted candidate code is built and run only on a local daemon, and the
// client's current context is never used. Every guarded operation is refused before the daemon sees a mutating call.
const codeOf = async (attempt: () => Promise<unknown>): Promise<string> => {
  try {
    await attempt();
  } catch (error) {
    return error instanceof RuntimeError ? error.code : `other: ${String(error)}`;
  }
  return "no error";
};

const spec = specFor("sut");
const handle = handleOf(spec);

/** The five operations that put candidate-influenced bytes on a daemon or run them. */
function guarded(runtime: ContainerRuntime): Array<() => Promise<unknown>> {
  return [
    () => runtime.ensureImage(pinnedImage(SUT_BASE)),
    () => runtime.build({ contextDir: "/work/ctx", tag: "omf-sut:x-1", labels: labelsFor("sut"), timeoutMs: 1000 }),
    () => runtime.create(spec),
    () => runtime.start(handle),
    () => runtime.exec(handle, { argv: ["true"], timeoutMs: 1000, maxOutputBytes: 1000 }),
  ];
}

describe("a docker context must be configured", () => {
  it("refuses every operation with context_not_configured and starts no docker call", async () => {
    const fake = new FakeDocker();
    const runtime = fakeRuntime(fake, null);
    expect(await runtime.info()).toEqual({ ok: false, failure: "docker context is not configured" });
    const reads = [
      () => runtime.endpoint(),
      () => runtime.imageInfo(SUT_BASE),
      () => runtime.inspect(handle),
      () => runtime.remove(handle),
    ];
    for (const attempt of [...guarded(runtime), ...reads]) expect(await codeOf(attempt)).toBe("context_not_configured");
    runtime.removeAllSync([spec.name]);
    expect(fake.state.calls).toEqual([]);
  });
});

describe.each([
  ["tcp", "tcp://10.0.0.5:2376", "tcp"],
  ["ssh", "ssh://dev@build-host", "ssh"],
  ["npipe", "npipe:////./pipe/docker_engine", "other"],
] as const)("a %s endpoint", (_label, host, kind) => {
  it("is reported as not local and refused before any build, pull, create, start or exec", async () => {
    const fake = new FakeDocker({ contexts: { remote: host } });
    const runtime = fakeRuntime(fake, "remote");
    expect(await runtime.endpoint()).toEqual({ kind, local: false });
    for (const attempt of guarded(runtime)) expect(await codeOf(attempt)).toBe("endpoint_not_local");
    expect(fake.verbs().filter((verb) => MUTATING_VERBS.has(verb))).toEqual([]);
    expect(fake.state.containers).toEqual({});
  });
});

describe("a local unix socket", () => {
  it("passes, and the answer is remembered", async () => {
    const fake = new FakeDocker();
    const runtime = fakeRuntime(fake);
    expect(await runtime.endpoint()).toEqual({ kind: "unix", local: true });
    await runtime.ensureImage(pinnedImage(SUT_BASE));
    await runtime.create(spec);
    expect(fake.verbs().filter((verb) => verb === "context inspect")).toHaveLength(1);
  });
});

describe("the guard fails closed", () => {
  it("on a context that cannot be inspected", async () => {
    const fake = new FakeDocker();
    const runtime = fakeRuntime(fake, "missing");
    expect(await codeOf(() => runtime.create(spec))).toBe("docker_failed");
    expect(fake.verbs().filter((verb) => MUTATING_VERBS.has(verb))).toEqual([]);
  });

  it("on an answer that is not JSON, and does not remember the failure", async () => {
    const fake = new FakeDocker();
    fake.intercept = (argv) =>
      argv[0] === "context" ? { kind: "exited", status: 0, signal: null, stdout: "not json", stderr: "" } : null;
    const runtime = fakeRuntime(fake);
    expect(await codeOf(() => runtime.create(spec))).toBe("output_malformed");
    fake.intercept = null;
    await runtime.create(spec);
    expect(fake.state.containers[spec.name]).toBeDefined();
  });
});
