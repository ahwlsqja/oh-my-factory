import { describe, expect, it } from "vitest";
import { goldenFor } from "../../src/container/golden.js";
import { createMeasured } from "../../src/container/measure.js";
import type { ImageInfo } from "../../src/container/runtime.js";
import type { ImageId } from "../../src/container/spec.js";
import type { ViolationCode } from "../../src/isolation/types.js";
import { type InspectDoc, measureFixture } from "../helpers/measure-fixture.js";

// W-implementer-image-no-codex: the implementer image holds the `claude` CLI and nothing else of the kind: a `codex` binary,
// a `~/.codex` or `~/.claude` login, a docker socket, a privileged or host-networked container or an extra bind is L1.
const PROBE = (...lines: string[]): string => `${[...lines, "socket:0", "end"].join("\n")}\n`;
const bindOf =
  (source: string, destination: string) =>
  (doc: InspectDoc): void => {
    doc.Mounts.push({
      Type: "bind",
      Source: source,
      Destination: destination,
      Mode: "rw",
      RW: true,
      Propagation: "rprivate",
    });
    doc.HostConfig.Binds = [`${source}:${destination}:rw`];
  };
const host =
  (key: string, value: unknown) =>
  (doc: InspectDoc): void => {
    doc.HostConfig[key] = value;
  };

describe("the implementer golden's tool and credential rules", () => {
  it("allows the claude binary and no credential path, on a bridge network", () => {
    const image: ImageInfo = { id: `sha256:${"b".repeat(64)}` as ImageId, env_names: ["PATH"], user: "", volumes: [] };
    expect(goldenFor({ role: "implementer", image, forbidden: [] })).toMatchObject({
      allowed_vendor_binaries: ["claude"],
      allowed_credential_paths: [],
      network: "bridge",
      require_read_only_rootfs: true,
    });
  });

  it("measures claude alone as clean and records an implementer stage, and no other stage", async () => {
    const f = await measureFixture({ probe: PROBE("vendor:claude") });
    await createMeasured(f.deps, f.spec("implementer"), f.golden("implementer"));
    expect(f.run().stages.implementer).toMatchObject({ level: "L2", measurements: 1, violations: [] });
    expect(f.run().stages.sut).toBeNull();
    expect(f.run().stages.harness).toBeNull();
  });

  it.each([
    ["a codex binary", PROBE("vendor:codex"), ["vendor_binary_present"]],
    ["claude and codex together", PROBE("vendor:claude", "vendor:codex"), ["vendor_binary_present"]],
    ["another vendor CLI", PROBE("vendor:claude", "vendor:aws"), ["vendor_binary_present"]],
    ["a ~/.codex directory", PROBE("cred:.codex"), ["credential_present"]],
    ["a ~/.claude login", PROBE("cred:.claude", "cred:.claude.json"), ["credential_present"]],
    ["a docker socket in the image", "socket:1\nend\n", ["docker_socket_present"]],
  ] as const)("%s is L1 after the probe", async (_label, probe, violations) => {
    const f = await measureFixture({ probe });
    await expect(createMeasured(f.deps, f.spec("implementer"), f.golden("implementer"))).rejects.toMatchObject({
      violations,
    });
    expect(f.lifecycle()).toEqual(["create", "inspect", "start", "exec", "rm"]);
    expect(f.run().stages.implementer).toMatchObject({ level: "L1", violations });
  });

  const deviations: Array<[string, (doc: InspectDoc) => void, ViolationCode[]]> = [
    ["host networking", host("NetworkMode", "host"), ["host_network"]],
    ["no network at all (the golden is bridge)", host("NetworkMode", "none"), ["network_not_none"]],
    ["privileged mode", host("Privileged", true), ["privileged"]],
    ["a writable root filesystem", host("ReadonlyRootfs", false), ["rootfs_writable"]],
    ["an extra bind mount", bindOf("/srv/data", "/srv/x"), ["unexpected_mount"]],
    [
      "the docker socket",
      bindOf("/var/run/docker.sock", "/var/run/docker.sock"),
      ["docker_socket_mounted", "unexpected_mount"],
    ],
  ];
  it.each(deviations)("%s is L1 before the container starts", async (_label, edit, violations) => {
    const f = await measureFixture({ inspect: edit });
    await expect(createMeasured(f.deps, f.spec("implementer"), f.golden("implementer"))).rejects.toMatchObject({
      violations,
    });
    expect(f.lifecycle()).toEqual(["create", "inspect", "rm"]);
    expect(f.run().stages.implementer).toMatchObject({ level: "L1", violations });
  });
});
