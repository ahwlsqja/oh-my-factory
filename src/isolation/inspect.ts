import type { ContainerFacts, MountFact } from "./types.js";

/**
 * A `docker inspect` document is missing a field or the field has the wrong type. The stage then stays
 * unmeasured (spec §2: absence is never a pass). The message names the field and nothing else: no input
 * text, no path, no environment value can leak through it.
 */
export class InspectParseError extends Error {
  constructor(readonly field: string) {
    super(`docker inspect field missing or malformed: ${field}`);
    this.name = "InspectParseError";
  }
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(parent: Json, key: string): unknown {
  return Object.hasOwn(parent, key) ? parent[key] : undefined;
}

function record(parent: Json, key: string, path: string): Json {
  const value = own(parent, key);
  if (!isRecord(value)) throw new InspectParseError(path);
  return value;
}

function text(parent: Json, key: string, path: string): string {
  const value = own(parent, key);
  if (typeof value !== "string") throw new InspectParseError(path);
  return value;
}

function flag(parent: Json, key: string, path: string): boolean {
  const value = own(parent, key);
  if (typeof value !== "boolean") throw new InspectParseError(path);
  return value;
}

/** A list of strings. The key must exist; Docker prints `null` for an empty list, which reads as `[]`. */
function strings(parent: Json, key: string, path: string): string[] {
  const value = own(parent, key);
  if (value === null) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new InspectParseError(path);
  return [...(value as string[])];
}

function mountType(type: string): MountFact["type"] {
  return type === "bind" || type === "volume" || type === "tmpfs" ? type : "other";
}

/** `Mounts[]`: what the daemon actually mounted. */
function fromMountEntry(entry: unknown): MountFact {
  if (!isRecord(entry)) throw new InspectParseError("Mounts");
  return {
    type: mountType(text(entry, "Type", "Mounts[].Type")),
    source: text(entry, "Source", "Mounts[].Source"),
    destination: text(entry, "Destination", "Mounts[].Destination"),
    read_only: !flag(entry, "RW", "Mounts[].RW"),
  };
}

/** `HostConfig.Binds[]`: `source:destination[:options]`. */
function fromBind(bind: string): MountFact {
  const parts = bind.split(":");
  const [source, destination, options] = parts;
  if (parts.length > 3 || source === undefined || destination === undefined || source === "" || destination === "") {
    throw new InspectParseError("HostConfig.Binds");
  }
  return {
    type: source.startsWith("/") ? "bind" : "volume",
    source,
    destination,
    read_only: (options ?? "").split(",").includes("ro"),
  };
}

/** `HostConfig.Mounts[]` (the `--mount` form). `Source` and `ReadOnly` are omitted by Docker when unset. */
function fromMountSpec(entry: unknown): MountFact {
  if (!isRecord(entry)) throw new InspectParseError("HostConfig.Mounts");
  const source = own(entry, "Source");
  const readOnly = own(entry, "ReadOnly");
  if (source !== undefined && typeof source !== "string") throw new InspectParseError("HostConfig.Mounts[].Source");
  if (readOnly !== undefined && typeof readOnly !== "boolean")
    throw new InspectParseError("HostConfig.Mounts[].ReadOnly");
  return {
    type: mountType(text(entry, "Type", "HostConfig.Mounts[].Type")),
    source: source ?? "",
    destination: text(entry, "Target", "HostConfig.Mounts[].Target"),
    read_only: readOnly === true,
  };
}

/**
 * `HostConfig.Tmpfs` (`--tmpfs`): destination to mount options. Docker omits the key when unset
 * (omitempty), so absent and null read as no tmpfs. A tmpfs given with `--tmpfs` is NOT listed in the
 * top-level `Mounts`, so ignoring this key would hide an unexpected tmpfs from the evaluator. It counts
 * as read-only only when the options say `ro` and not `rw`.
 */
function fromTmpfs(value: unknown): MountFact[] {
  if (value === undefined || value === null) return [];
  if (!isRecord(value)) throw new InspectParseError("HostConfig.Tmpfs");
  return Object.entries(value).map(([destination, options]) => {
    if (destination === "" || typeof options !== "string") throw new InspectParseError("HostConfig.Tmpfs");
    const tokens = options.split(",");
    return { type: "tmpfs", source: "", destination, read_only: tokens.includes("ro") && !tokens.includes("rw") };
  });
}

function mountKey(mount: MountFact): string {
  return `${mount.destination}\u0000${mount.source}\u0000${mount.type}\u0000${mount.read_only}`;
}

function listOfRecords(value: unknown, path: string): Json[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every(isRecord)) throw new InspectParseError(path);
  return value as Json[];
}

function unwrap(inspect: unknown): Json {
  const value = Array.isArray(inspect) ? (inspect.length === 1 ? inspect[0] : undefined) : inspect;
  if (!isRecord(value)) throw new InspectParseError("inspect");
  return value;
}

/**
 * `docker inspect <id>` JSON (the array of one, or the object) to the facts the evaluator judges.
 * Every isolation-relevant field is required: a missing one throws instead of defaulting to the safe
 * value. Mounts from the three places Docker reports them are merged and de-duplicated, so a bind that
 * appears only in `HostConfig.Binds` still counts. Environment values are dropped here and never held.
 *
 * The field mapping follows the Docker Engine API and is checked against real `docker inspect` output
 * (tests/fixtures/docker-inspect). A field reads as empty when absent only if the runtime omits it when
 * unset (omitempty: Sysctls, Runtime, HostConfig.Mounts, Tmpfs) and its absence cannot hide a weakening;
 * StorageOpt, Annotations and Init are never read. For every other field a default would hide an unknown,
 * so the parser throws instead.
 */
export function containerFactsFromInspect(inspect: unknown): ContainerFacts {
  const top = unwrap(inspect);
  const config = record(top, "Config", "Config");
  const host = record(top, "HostConfig", "HostConfig");

  const actual = own(top, "Mounts");
  if (!Array.isArray(actual)) throw new InspectParseError("Mounts");
  const merged = new Map<string, MountFact>();
  const sources = [
    ...actual.map(fromMountEntry),
    ...strings(host, "Binds", "HostConfig.Binds").map(fromBind),
    ...listOfRecords(own(host, "Mounts"), "HostConfig.Mounts").map(fromMountSpec),
    ...fromTmpfs(own(host, "Tmpfs")),
  ];
  for (const mount of sources) merged.set(mountKey(mount), mount);

  const envNames = new Set<string>();
  for (const entry of strings(config, "Env", "Config.Env")) {
    const equals = entry.indexOf("=");
    envNames.add(equals < 0 ? entry : entry.slice(0, equals));
  }

  const devices = own(host, "Devices");
  let devicePaths: string[];
  if (devices === null) devicePaths = [];
  else if (Array.isArray(devices) && devices.every(isRecord)) {
    devicePaths = devices.map((device) => text(device as Json, "PathOnHost", "HostConfig.Devices"));
  } else throw new InspectParseError("HostConfig.Devices");

  // The Engine API omits Sysctls and Runtime when unset (omitempty). Absence is the absence of a weakening
  // setting, so Sysctls reads as empty and Runtime as "" (which the evaluator still flags as not runc).
  const sysctls = own(host, "Sysctls") ?? null;
  if (sysctls !== null && !isRecord(sysctls)) throw new InspectParseError("HostConfig.Sysctls");

  return {
    container_id: text(top, "Id", "Id"),
    image: text(config, "Image", "Config.Image"),
    mounts: [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, mount]) => mount),
    env_names: [...envNames].sort(),
    cap_add: strings(host, "CapAdd", "HostConfig.CapAdd"),
    cap_drop: strings(host, "CapDrop", "HostConfig.CapDrop"),
    privileged: flag(host, "Privileged", "HostConfig.Privileged"),
    network_mode: text(host, "NetworkMode", "HostConfig.NetworkMode"),
    pid_mode: text(host, "PidMode", "HostConfig.PidMode"),
    user: text(config, "User", "Config.User"),
    read_only_rootfs: flag(host, "ReadonlyRootfs", "HostConfig.ReadonlyRootfs"),
    security_opt: strings(host, "SecurityOpt", "HostConfig.SecurityOpt"),
    devices: devicePaths,
    ipc_mode: text(host, "IpcMode", "HostConfig.IpcMode"),
    uts_mode: text(host, "UTSMode", "HostConfig.UTSMode"),
    userns_mode: text(host, "UsernsMode", "HostConfig.UsernsMode"),
    cgroupns_mode: text(host, "CgroupnsMode", "HostConfig.CgroupnsMode"),
    volumes_from: strings(host, "VolumesFrom", "HostConfig.VolumesFrom"),
    sysctls: sysctls === null ? [] : Object.keys(sysctls).sort(),
    runtime: own(host, "Runtime") === undefined ? "" : text(host, "Runtime", "HostConfig.Runtime"),
  };
}
