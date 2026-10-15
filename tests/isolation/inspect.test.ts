import { describe, expect, it } from "vitest";
import { InspectParseError, containerFactsFromInspect } from "../../src/isolation/inspect.js";
import { SCENARIOS, WORKTREE, goldenInspect } from "../helpers/inspect-fixtures.js";

const SECRET = "s3cr3t-value-9f2";

const GOLDEN_FACTS = {
  container_id: "c0ffee",
  image: "omf-implementer:1",
  mounts: [
    { type: "bind", source: SCENARIOS, destination: "/scenarios", read_only: true },
    { type: "tmpfs", source: "", destination: "/tmp", read_only: false },
    { type: "bind", source: WORKTREE, destination: "/work", read_only: false },
  ],
  env_names: ["HOME", "OMF_STAGE", "PATH"],
  cap_add: [],
  cap_drop: ["ALL"],
  privileged: false,
  network_mode: "none",
  pid_mode: "",
  user: "10001:10001",
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
};

function without(path: string): unknown {
  const doc = goldenInspect() as Record<string, unknown>;
  const keys = path.split(".");
  const last = keys.pop() as string;
  let node = doc;
  for (const key of keys) node = node[key] as Record<string, unknown>;
  delete node[last];
  return doc;
}

describe("containerFactsFromInspect", () => {
  it("reads the golden document, whether it is the object or the array of one", () => {
    expect(containerFactsFromInspect(goldenInspect())).toEqual(GOLDEN_FACTS);
    expect(containerFactsFromInspect([goldenInspect()])).toEqual(GOLDEN_FACTS);
    expect(() => containerFactsFromInspect([goldenInspect(), goldenInspect()])).toThrow(InspectParseError);
    expect(() => containerFactsFromInspect("nope")).toThrow(InspectParseError);
  });

  it("reads mounts from Mounts alone, from Binds alone and from HostConfig.Mounts alone", () => {
    const mountsOnly = goldenInspect();
    mountsOnly.HostConfig.Binds = null;
    expect(containerFactsFromInspect(mountsOnly).mounts).toEqual(GOLDEN_FACTS.mounts);

    const bindsOnly = goldenInspect();
    bindsOnly.Mounts = [];
    expect(containerFactsFromInspect(bindsOnly).mounts).toEqual([GOLDEN_FACTS.mounts[0], GOLDEN_FACTS.mounts[2]]);

    const specOnly = goldenInspect();
    specOnly.Mounts = [];
    specOnly.HostConfig.Binds = null;
    specOnly.HostConfig.Mounts = [{ Type: "bind", Source: "/srv/data", Target: "/data", ReadOnly: true }];
    expect(containerFactsFromInspect(specOnly).mounts).toEqual([
      { type: "bind", source: "/srv/data", destination: "/data", read_only: true },
    ]);
  });

  it("parses bind options, a named volume and rejects a malformed bind", () => {
    const doc = goldenInspect();
    doc.Mounts = [];
    doc.HostConfig.Binds = ["/srv/a:/a:ro,z", "cache:/cache"];
    expect(containerFactsFromInspect(doc).mounts).toEqual([
      { type: "bind", source: "/srv/a", destination: "/a", read_only: true },
      { type: "volume", source: "cache", destination: "/cache", read_only: false },
    ]);
    doc.HostConfig.Binds = ["nonsense"];
    expect(() => containerFactsFromInspect(doc)).toThrow(/HostConfig\.Binds/);
  });

  it("keeps environment names and never a value", () => {
    const doc = goldenInspect();
    doc.Config.Env = ["PATH=/usr/bin", `API_TOKEN=${SECRET}`, `A=b=${SECRET}`, "BARE"];
    const facts = containerFactsFromInspect(doc);
    expect(facts.env_names).toEqual(["A", "API_TOKEN", "BARE", "PATH"]);
    expect(JSON.stringify(facts)).not.toContain(SECRET);
  });

  it("keeps the names of devices and sysctls, not their settings", () => {
    const doc = goldenInspect();
    doc.HostConfig.Devices = [{ PathOnHost: "/dev/fuse", PathInContainer: "/dev/fuse", CgroupPermissions: "rwm" }];
    doc.HostConfig.Sysctls = { "net.ipv4.ip_forward": "1" };
    expect(containerFactsFromInspect(doc)).toMatchObject({ devices: ["/dev/fuse"], sysctls: ["net.ipv4.ip_forward"] });
  });

  const REQUIRED = [
    "Id",
    "Config",
    "Config.Image",
    "Config.User",
    "Config.Env",
    "Mounts",
    "HostConfig",
    "HostConfig.Binds",
    "HostConfig.Privileged",
    "HostConfig.CapAdd",
    "HostConfig.CapDrop",
    "HostConfig.NetworkMode",
    "HostConfig.PidMode",
    "HostConfig.ReadonlyRootfs",
    "HostConfig.SecurityOpt",
    "HostConfig.Devices",
    "HostConfig.IpcMode",
    "HostConfig.UTSMode",
    "HostConfig.UsernsMode",
    "HostConfig.CgroupnsMode",
    "HostConfig.VolumesFrom",
  ];

  it("reads a realistic inspect that omits the keys the Engine API leaves out when unset", () => {
    const doc = goldenInspect() as unknown as { HostConfig: Record<string, unknown> };
    delete doc.HostConfig.Sysctls;
    delete doc.HostConfig.Runtime;
    delete doc.HostConfig.Tmpfs;
    const facts = containerFactsFromInspect(doc);
    expect(facts.sysctls).toEqual([]);
    expect(facts.runtime).toBe("");
    doc.HostConfig.Sysctls = null;
    expect(containerFactsFromInspect(doc).sysctls).toEqual([]);
    doc.HostConfig.Sysctls = "x";
    expect(() => containerFactsFromInspect(doc)).toThrow(/HostConfig\.Sysctls/);
  });

  it.each(REQUIRED)("fails closed when %s is missing, naming only that field", (path) => {
    const doc = without(path) as { Config?: { Env?: string[] } };
    if (doc.Config?.Env !== undefined) doc.Config.Env.push(`LEAK=${SECRET}`);
    let thrown: unknown;
    try {
      containerFactsFromInspect(doc);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InspectParseError);
    const error = thrown as InspectParseError;
    expect(error.field).toBe(path);
    expect(error.message).toContain(path);
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain(WORKTREE);
  });

  it("fails closed on a wrong type and on a mount entry without its fields", () => {
    const wrongType = goldenInspect();
    wrongType.HostConfig.Privileged = "false";
    expect(() => containerFactsFromInspect(wrongType)).toThrow(/HostConfig\.Privileged/);

    const notAList = goldenInspect();
    notAList.HostConfig.SecurityOpt = "no-new-privileges";
    expect(() => containerFactsFromInspect(notAList)).toThrow(/HostConfig\.SecurityOpt/);

    const noRw = goldenInspect();
    delete (noRw.Mounts[0] as Record<string, unknown>).RW;
    expect(() => containerFactsFromInspect(noRw)).toThrow(/Mounts\[\]\.RW/);
  });
});
