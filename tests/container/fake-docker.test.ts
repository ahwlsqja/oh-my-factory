import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createArgv, inspectArgv } from "../../src/container/argv.js";
import type { ContainerRole } from "../../src/container/spec.js";
import { containerFactsFromInspect } from "../../src/isolation/inspect.js";
import type { ContainerFacts } from "../../src/isolation/types.js";
import { HARNESS_BASE, SUT_BASE, specFor } from "../helpers/container-fixture.js";
import { FakeDocker } from "../helpers/fake-docker.js";

const LIMITS = { timeoutMs: 1000, maxOutputBytes: 1_000_000 };

/** The stdout of a successful fake call; anything else fails the test. */
async function stdoutOf(fake: FakeDocker, argv: string[]): Promise<string> {
  const result = await fake.run(argv, LIMITS);
  if (result.kind !== "exited" || result.status !== 0)
    throw new Error(`fake docker refused: ${JSON.stringify(result)}`);
  return result.stdout;
}

async function factsOf(fake: FakeDocker, role: ContainerRole): Promise<ContainerFacts> {
  const spec = specFor(role);
  await stdoutOf(fake, createArgv(spec, "fake"));
  return containerFactsFromInspect(JSON.parse(await stdoutOf(fake, inspectArgv(spec.name, "fake"))));
}

const tmpfs = (destination: string) => ({ type: "tmpfs", source: "", destination, read_only: false });
const golden = (image: string, destinations: string[]) => ({
  container_id: expect.stringMatching(/^[0-9a-f]{64}$/),
  image,
  mounts: destinations.map(tmpfs),
  env_names: ["LC_ALL", "NODE_VERSION", "PATH"],
  cap_add: [],
  cap_drop: ["ALL"],
  privileged: false,
  network_mode: "none",
  pid_mode: "",
  user: "65532:65532",
  read_only_rootfs: true,
  security_opt: ["no-new-privileges"],
  devices: [],
  ipc_mode: "private",
  uts_mode: "",
  userns_mode: "",
  cgroupns_mode: "private",
  volumes_from: [],
  sysctls: [],
  runtime: "runc",
  init: false,
});

describe("FakeDocker", () => {
  it("builds inspect JSON from the create flags it saw: the golden argv parses to golden facts", async () => {
    expect(await factsOf(new FakeDocker(), "sut")).toEqual(golden(SUT_BASE, ["/scratch", "/tmp"]));
    expect(await factsOf(new FakeDocker(), "harness")).toEqual(golden(HARNESS_BASE, ["/state", "/tmp"]));
    expect(await factsOf(new FakeDocker(), "workcopy")).toEqual(golden(SUT_BASE, ["/tmp", "/work"]));
  });

  it("lets a test model a deviation by editing the inspect document", async () => {
    const fake = new FakeDocker({
      tamper: (doc) => {
        (doc.HostConfig as Record<string, unknown>).Privileged = true;
      },
    });
    expect((await factsOf(fake, "sut")).privileged).toBe(true);
  });

  it("rejects what the real client would: an unknown flag, a missing image, a reused name, a stopped daemon", async () => {
    const fake = new FakeDocker();
    expect(await fake.run(["create", "--name", "n", "--privileged", "x"], LIMITS)).toMatchObject({
      status: 125,
      stderr: expect.stringContaining("unknown flag: --privileged"),
    });
    const absent = `example.test/none@sha256:${"d".repeat(64)}`;
    expect(await fake.run(["create", "--name", "n", "--pull", "never", absent], LIMITS)).toMatchObject({
      status: 125,
      stderr: expect.stringContaining("Unable to find image"),
    });
    await stdoutOf(fake, createArgv(specFor("sut"), null));
    expect(await fake.run(createArgv(specFor("sut"), null), LIMITS)).toMatchObject({ status: 125 });
    expect(await fake.run(["--context", "nope", "info"], LIMITS)).toMatchObject({ status: 1 });
    fake.state.daemon_down = true;
    expect(await fake.run(["--context", "fake", "info"], LIMITS)).toMatchObject({
      status: 1,
      stderr: expect.stringContaining("Cannot connect to the Docker daemon"),
    });
  });
});

// The golden-to-L2 chain must not be circular: the fake derives its inspect JSON from the flags, so its facts for the
// golden argv must equal the facts of a document a real daemon produced. The fixture is captured by the gated inspect test.
const REAL = new URL("../fixtures/docker-inspect/hardened-tmpfs.json", import.meta.url);

describe("FakeDocker and --init=false", () => {
  it("reports Init false for the golden create argv", async () => {
    expect((await factsOf(new FakeDocker(), "sut")).init).toBe(false);
  });
});

describe("FakeDocker against a real docker inspect document", () => {
  it.skipIf(!existsSync(REAL))("a golden container has the same facts as the committed real document", async () => {
    const mask = (facts: ContainerFacts) => ({
      ...facts,
      container_id: "",
      image: "",
      env_names: [],
      mounts: [],
    });
    const real = containerFactsFromInspect(JSON.parse(readFileSync(REAL, "utf8")));
    expect(mask(await factsOf(new FakeDocker(), "sut"))).toEqual(mask(real));
  });
});
