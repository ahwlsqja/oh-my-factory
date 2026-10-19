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
  init: false,
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

  it("reads HostConfig.Init: false and true as they are, and unset (which leaves the daemon default) as null", () => {
    const doc = goldenInspect() as unknown as { HostConfig: Record<string, unknown> };
    expect(containerFactsFromInspect(doc).init).toBe(false);
    doc.HostConfig.Init = true;
    expect(containerFactsFromInspect(doc).init).toBe(true);
    delete doc.HostConfig.Init;
    expect(containerFactsFromInspect(doc).init).toBeNull();
    doc.HostConfig.Init = null;
    expect(containerFactsFromInspect(doc).init).toBeNull();
    doc.HostConfig.Init = "false";
    expect(() => containerFactsFromInspect(doc)).toThrow(/HostConfig\.Init/);
  });

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

describe("omitempty keys and null slices", () => {
  // Docker omits these HostConfig keys when they are unset (Go `omitempty`). None of them can hide a
  // weakening by being absent, so absent, null and empty all leave the facts unchanged. StorageOpt and
  // Annotations are never read at all: no value of theirs can matter to isolation. Init is read (above): unset is not golden.
  const NEUTRAL: ReadonlyArray<[string, unknown[]]> = [
    ["Tmpfs", [undefined, null, {}]],
    ["Sysctls", [undefined, null, {}]],
    ["Mounts", [undefined, null, []]],
    ["StorageOpt", [undefined, null, {}]],
    ["Annotations", [undefined, null, {}]],
  ];

  it.each(NEUTRAL)("HostConfig.%s: unset in every form reads as the golden facts", (key, variants) => {
    for (const variant of variants) {
      const doc = goldenInspect();
      if (variant === undefined) delete doc.HostConfig[key];
      else doc.HostConfig[key] = variant;
      expect(containerFactsFromInspect(doc), `${key}=${JSON.stringify(variant)}`).toEqual(GOLDEN_FACTS);
    }
  });

  it("HostConfig.Runtime: absent reads as empty (the evaluator then flags it), null and a wrong type fail closed", () => {
    const absent = goldenInspect();
    delete absent.HostConfig.Runtime;
    expect(containerFactsFromInspect(absent).runtime).toBe("");
    for (const bad of [null, 7]) {
      const doc = goldenInspect();
      doc.HostConfig.Runtime = bad;
      expect(() => containerFactsFromInspect(doc)).toThrow(/HostConfig\.Runtime/);
    }
  });

  // Docker prints null for an empty list in these fields, and [] in some versions. The key itself is
  // always printed, so a missing key is an unknown and must throw.
  const SLICES: ReadonlyArray<[string, string | null]> = [
    ["Binds", null],
    ["Devices", "devices"],
    ["CapAdd", "cap_add"],
    ["CapDrop", "cap_drop"],
    ["SecurityOpt", "security_opt"],
    ["VolumesFrom", "volumes_from"],
  ];

  it.each(SLICES)("HostConfig.%s: null and [] read as empty, a missing key or a wrong type throws", (key, factsKey) => {
    const field = `HostConfig.${key}`;
    for (const empty of [null, []]) {
      const doc = goldenInspect();
      doc.HostConfig[key] = empty;
      const facts = containerFactsFromInspect(doc) as unknown as Record<string, unknown>;
      if (factsKey !== null) expect(facts[factsKey]).toEqual([]);
    }
    const missing = goldenInspect();
    delete missing.HostConfig[key];
    expect(() => containerFactsFromInspect(missing)).toThrow(new InspectParseError(field).message);
    const wrong = goldenInspect();
    wrong.HostConfig[key] = { not: "a list" };
    expect(() => containerFactsFromInspect(wrong)).toThrow(new InspectParseError(field).message);
  });
});

describe("HostConfig.Tmpfs", () => {
  // `--tmpfs /tmp` is recorded only in HostConfig.Tmpfs (destination to mount options). It is not in the
  // top-level Mounts, so a parser that ignores the key cannot see an unexpected tmpfs at all.
  it("reads each entry as a tmpfs mount, read-only only when the options say ro", () => {
    const doc = goldenInspect();
    doc.Mounts = [];
    doc.HostConfig.Binds = null;
    doc.HostConfig.Tmpfs = { "/tmp": "rw,noexec,nosuid,size=16384k", "/scratch": "", "/ro": "ro,nosuid" };
    expect(containerFactsFromInspect(doc).mounts).toEqual([
      { type: "tmpfs", source: "", destination: "/ro", read_only: true },
      { type: "tmpfs", source: "", destination: "/scratch", read_only: false },
      { type: "tmpfs", source: "", destination: "/tmp", read_only: false },
    ]);
  });

  it("counts a tmpfs once when it is also listed in the top-level Mounts", () => {
    const doc = goldenInspect();
    doc.HostConfig.Tmpfs = { "/tmp": "rw,size=1m" };
    expect(containerFactsFromInspect(doc).mounts).toEqual(GOLDEN_FACTS.mounts);
  });

  it.each([
    ["a string", "/tmp"],
    ["a list", ["/tmp"]],
    ["a non-string option value", { "/tmp": 5 }],
    ["an empty destination", { "": "rw" }],
  ])("fails closed on %s", (_label, value) => {
    const doc = goldenInspect();
    doc.HostConfig.Tmpfs = value;
    expect(() => containerFactsFromInspect(doc)).toThrow(/HostConfig\.Tmpfs/);
  });
});
