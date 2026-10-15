import { describe, expect, it } from "vitest";
import { createArgv, execArgv, removeArgv } from "../../src/container/argv.js";
import { createDockerRuntime, dockerEnv, resolveDockerConfig } from "../../src/container/docker-cli.js";
import { pinnedImage } from "../../src/container/image-ref.js";
import { RuntimeError } from "../../src/container/runtime.js";
import { containerName } from "../../src/container/spec.js";
import { FIXTURE_RUN_ID, SUT_BASE, labelsFor, specFor } from "../helpers/container-fixture.js";
import { FakeDocker, fakeDockerBin, verbOf } from "../helpers/fake-docker.js";
import { addRegistryImage } from "../helpers/fake-docker-core.mjs";
import { fakeRuntime } from "../helpers/fake-runtime.js";

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return error instanceof RuntimeError ? error.code : `other: ${String(error)}`;
  }
  return "no error";
};

describe("resolveDockerConfig and dockerEnv", () => {
  it.each([
    [{ DOCKER_CONFIG: "/c" }, "/c"],
    [{ HOME: "/h" }, "/h/.docker"],
    [{ DOCKER_CONFIG: "/c", HOME: "/h" }, "/c"],
    [{}, "/nonexistent/omf-docker-config"],
    [{ HOME: "relative" }, "/nonexistent/omf-docker-config"],
    [{ DOCKER_CONFIG: "relative", HOME: "/h" }, "/nonexistent/omf-docker-config"],
  ])("%j resolves to %s, never to the passwd home", (env, expected) => {
    expect(resolveDockerConfig(env)).toBe(expected);
  });

  it("hands the client PATH and DOCKER_CONFIG only", () => {
    const env = dockerEnv({ PATH: "/usr/bin", HOME: "/h", OMF_HOME: "/h/.omf", ANTHROPIC_API_KEY: "k" }, "/h/.docker");
    expect(env).toEqual({ PATH: "/usr/bin", DOCKER_CONFIG: "/h/.docker" });
  });
});

describe("createDockerRuntime over a fake daemon", () => {
  it("creates, inspects, starts, runs, and removes a container through the port", async () => {
    const fake = new FakeDocker({ exec: () => ({ status: 0, stdout: "ran\n", stderr: "" }) });
    const runtime = fakeRuntime(fake);
    const spec = specFor("sut");
    const handle = await runtime.create(spec);
    expect(handle).toMatchObject({ name: spec.name, role: "sut" });
    expect(handle.id).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.calls("create")[0]?.argv).toEqual(createArgv(spec, "fake"));

    expect(await runtime.inspect(handle)).toEqual([expect.objectContaining({ Id: handle.id })]);
    await runtime.start(handle);
    const stdin = Buffer.from([0xff, 0x00, 0x80]);
    const argv = ["tool", "--privileged"];
    const result = await runtime.exec(handle, {
      argv,
      stdin,
      workdir: "/scratch",
      env: { HOME: "/scratch" },
      timeoutMs: 1000,
      maxOutputBytes: 1000,
    });
    expect(result).toMatchObject({ kind: "exited", status: 0, stdout: "ran\n" });
    const call = fake.calls("exec")[0];
    expect(call?.argv).toEqual(
      execArgv(spec.name, { argv, workdir: "/scratch", env: { HOME: "/scratch" }, stdin: true }, "fake"),
    );
    expect(call?.stdin_b64).toBe(stdin.toString("base64"));

    await runtime.remove(handle);
    await runtime.remove(handle);
    expect(fake.state.containers[spec.name]).toBeUndefined();
  });

  it("builds an image with no network, no pull and no cache, and refuses one that declares a volume", async () => {
    const fake = new FakeDocker();
    const runtime = fakeRuntime(fake);
    const build = {
      contextDir: "/work/ctx",
      tag: `omf-sut:${FIXTURE_RUN_ID}-1`,
      labels: labelsFor("sut"),
      timeoutMs: 1000,
    };
    expect((await runtime.build(build)).id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fake.calls("build")[0]?.argv).toEqual(
      expect.arrayContaining(["--network", "none", "--pull=false", "--no-cache"]),
    );
    fake.state.build_volumes = ["/data"];
    expect(await codeOf(runtime.build({ ...build, tag: `omf-sut:${FIXTURE_RUN_ID}-2` }))).toBe("image_declares_volume");
  });

  it("ensureImage pulls a digest reference only when the image is absent, and refuses a volume", async () => {
    const fake = new FakeDocker();
    const absent = `example.test/omf/other@sha256:${"c".repeat(64)}`;
    const volume = `example.test/omf/volume@sha256:${"f".repeat(64)}`;
    addRegistryImage(fake.state, absent, { env: ["PATH=/bin", "NODE_VERSION=22"] });
    addRegistryImage(fake.state, volume, { volumes: ["/data"] });
    const runtime = fakeRuntime(fake);

    expect((await runtime.ensureImage(pinnedImage(SUT_BASE))).env_names).toEqual(["PATH", "NODE_VERSION"]);
    expect(fake.calls("pull")).toEqual([]);

    expect((await runtime.ensureImage(pinnedImage(absent))).env_names).toEqual(["PATH", "NODE_VERSION"]);
    expect(fake.calls("pull").map((call) => call.argv)).toEqual([["--context", "fake", "pull", "--quiet", absent]]);
    await runtime.ensureImage(pinnedImage(absent));
    expect(fake.calls("pull")).toHaveLength(1);

    expect(await codeOf(runtime.ensureImage(pinnedImage(volume)))).toBe("image_declares_volume");
    const unknown = `example.test/omf/unknown@sha256:${"d".repeat(64)}`;
    expect(await codeOf(runtime.ensureImage(pinnedImage(unknown)))).toBe("docker_failed");
  });

  it("info reports the version, the exact docker failure text, or a missing binary", async () => {
    const fake = new FakeDocker();
    expect(await fakeRuntime(fake).info()).toEqual({ ok: true, server_version: "29.0.0" });
    fake.state.daemon_down = true;
    expect(await fakeRuntime(fake).info()).toEqual({
      ok: false,
      failure: expect.stringContaining("Cannot connect to the Docker daemon"),
    });
    const missing = createDockerRuntime({
      context: "fake",
      run: async () => ({ kind: "error", code: "ENOENT", message: "spawn docker ENOENT" }),
      env: { PATH: "/nowhere" },
    });
    expect(await missing.info()).toEqual({ ok: false, failure: "spawn docker ENOENT" });
  });

  it("removeAllSync removes by name through the sync runner, never throws, and does nothing without names", async () => {
    const fake = new FakeDocker();
    const spec = specFor("sut");
    await fakeRuntime(fake).create(spec);
    fakeRuntime(fake).removeAllSync([spec.name]);
    expect(fake.state.containers[spec.name]).toBeUndefined();

    const seen: string[][] = [];
    const names = [spec.name, containerName(labelsFor("harness"), 2)];
    const recording = createDockerRuntime({
      context: "fake",
      runSync: (argv) => {
        seen.push([...argv]);
        return { status: 0, stdout: "", stderr: "" };
      },
      env: { PATH: "/usr/bin" },
    });
    recording.removeAllSync(names);
    recording.removeAllSync([]);
    expect(seen).toEqual([removeArgv(names, "fake")]);

    const throwing = createDockerRuntime({
      context: "fake",
      runSync: () => {
        throw new Error("boom");
      },
      env: { PATH: "/usr/bin" },
    });
    expect(() => throwing.removeAllSync(names)).not.toThrow();
  });
});

describe("the default runner", () => {
  it("starts the docker program with PATH and DOCKER_CONFIG only and delivers binary stdin", async () => {
    const bin = fakeDockerBin();
    const runtime = createDockerRuntime({
      context: "fake",
      env: { PATH: bin.path, HOME: "/home/x", OMF_HOME: "/home/x/.omf", ANTHROPIC_API_KEY: "k" },
    });
    expect(await runtime.info()).toEqual({ ok: true, server_version: "29.0.0" });
    const spec = specFor("sut");
    const handle = await runtime.create(spec);
    await runtime.start(handle);
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x80]);
    const result = await runtime.exec(handle, { argv: ["cat"], stdin: bytes, timeoutMs: 10_000, maxOutputBytes: 1000 });
    expect(result).toMatchObject({ kind: "exited", status: 0 });

    const { calls, containers } = bin.state();
    expect(new Set(calls.map((call) => call.env_keys?.join(",")))).toEqual(new Set(["DOCKER_CONFIG,PATH"]));
    expect(new Set(calls.map((call) => call.docker_config))).toEqual(new Set(["/home/x/.docker"]));
    expect(calls.find((call) => verbOf(call.argv) === "exec")?.stdin_b64).toBe(bytes.toString("base64"));
    expect(containers[spec.name]?.running).toBe(true);
    await runtime.remove(handle);
    expect(bin.state().containers[spec.name]).toBeUndefined();
  });

  it("reports a missing program as a failure text, not a crash", async () => {
    const runtime = createDockerRuntime({ context: "fake", env: { PATH: "/nonexistent-omf-bin" } });
    expect(await runtime.info()).toEqual({ ok: false, failure: expect.stringContaining("ENOENT") });
  });
});
