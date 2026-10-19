import { join } from "node:path";
import type { ProcessResult } from "../../src/adapters/process-group.js";
import { type DockerRunner, createDockerRuntime } from "../../src/container/docker-cli.js";
import { containerSpecFor, goldenFor } from "../../src/container/golden.js";
import { type PinnedImage, pinnedImage } from "../../src/container/image-ref.js";
import type { MeasureDeps } from "../../src/container/measure.js";
import type { ContainerRuntime, ImageInfo } from "../../src/container/runtime.js";
import type { ContainerRole, ContainerSpec } from "../../src/container/spec.js";
import { Ledger } from "../../src/core/ledger.js";
import type { StageGolden } from "../../src/isolation/evaluate.js";
import { loadRunIsolation } from "../../src/isolation/record.js";
import type { ViolationCode } from "../../src/isolation/types.js";
import { FakeDocker } from "./fake-docker.js";
import { limitsFor } from "./container-fixture.js";
import { addImage } from "./fake-docker-core.mjs";
import { makeTempDir } from "./tmp.js";

export const AT = new Date("2026-10-15T09:00:00Z");
export const WORK = "w-0123456789ab";
export const RUN = "r-20261015T090000Z-ab12";
export const CONTEXT = "colima-omf-m3f";
export const BASE: PinnedImage = pinnedImage(`registry.example/omf-base@sha256:${"a".repeat(64)}`);
/** Invented paths: nothing here touches a real home. */
export const HOME = "/home/dev";
export const VAULT = "/home/dev/.omf/projects/p-1/vault";
export const FORBIDDEN = [VAULT, "/home/dev/repo", HOME];
/** What the fixed probe prints in a clean container. */
export const CLEAN_PROBE = "socket:0\nend\n";

export interface InspectDoc {
  Id: string;
  Config: { Env?: string[] | null; User?: string; [key: string]: unknown };
  Mounts: Array<Record<string, unknown>>;
  HostConfig: Record<string, unknown>;
}

/** How a test bends what the fake daemon reports. */
export interface Tamper {
  inspect?: (doc: InspectDoc) => void;
  /** Replaces the whole stdout of `docker inspect`. */
  inspectBody?: string;
  /** What the in-container probe returns: stdout of a clean exit, or a full result. */
  probe?: string | ProcessResult;
}

/** The docker verb of an argv: skips `--context <name>` and `container`, keeps `image-` and `context-` prefixes. */
export function verbOf(argv: readonly string[]): string {
  const rest = argv[0] === "--context" ? argv.slice(2) : argv;
  const [first = "", second = ""] = rest;
  if (first === "container") return second;
  return first === "image" || first === "context" ? `${first}-${second}` : first;
}

const exited = (stdout: string): ProcessResult => ({ kind: "exited", status: 0, signal: null, stdout, stderr: "" });

/** Records every argv, answers the probe exec itself, and edits the container's inspect document. */
export function tampered(
  run: DockerRunner,
  tamper: Tamper,
  seen: string[][],
  envSeen?: Array<Readonly<Record<string, string>> | undefined>,
): DockerRunner {
  return async (argv, options) => {
    seen.push([...argv]);
    envSeen?.push(options.env);
    const verb = verbOf(argv);
    if (verb === "exec" && tamper.probe !== undefined) {
      return typeof tamper.probe === "string" ? exited(tamper.probe) : tamper.probe;
    }
    const result = await run(argv, options);
    if (verb !== "inspect" || result.kind !== "exited" || result.status !== 0) return result;
    if (tamper.inspectBody !== undefined) return { ...result, stdout: tamper.inspectBody };
    if (tamper.inspect === undefined) return result;
    const docs = JSON.parse(result.stdout) as InspectDoc[];
    const [doc] = docs;
    if (doc === undefined) return result;
    tamper.inspect(doc);
    return { ...result, stdout: JSON.stringify(docs) };
  };
}

export interface MeasureFixture {
  deps: MeasureDeps;
  itemDir: string;
  seen: string[][];
  /** The extra client environment of each call in seen (undefined for a call that had none). */
  envs: Array<Readonly<Record<string, string>> | undefined>;
  /** Container lifecycle verbs only, in call order. */
  lifecycle(): string[];
  spec(role: ContainerRole, serial?: number): ContainerSpec;
  golden(role: ContainerRole): StageGolden;
  isolationEvents(): Array<{ payload: Record<string, unknown> }>;
  run(): ReturnType<typeof loadRunIsolation>;
}

const LIFECYCLE = new Set(["create", "inspect", "start", "exec", "rm"]);

export async function measureFixture(
  tamper: Tamper = {},
  options: { imageEnv?: string[] } = {},
): Promise<MeasureFixture> {
  const fake = new FakeDocker();
  // The fake core's default image env is PATH only, so the base reads env_names ["PATH"]; `imageEnv` models an owner-built image.
  addImage(fake.state, BASE, options.imageEnv === undefined ? {} : { env: options.imageEnv });
  const seen: string[][] = [];
  const envs: Array<Readonly<Record<string, string>> | undefined> = [];
  const runtime: ContainerRuntime = createDockerRuntime({
    context: CONTEXT,
    run: tampered(fake.run, { probe: CLEAN_PROBE, ...tamper }, seen, envs),
  });
  const image: ImageInfo = await runtime.ensureImage(BASE);
  const dir = makeTempDir("omf-measure-");
  const ledger = new Ledger(dir, () => AT);
  const itemDir = join(dir, "items", WORK);
  const scope = { goal_id: "g-fast", work_id: WORK, run_id: RUN };
  return {
    deps: { runtime, sink: ledger, scope, itemDir, now: () => AT },
    itemDir,
    seen,
    envs,
    lifecycle: () => seen.map(verbOf).filter((verb) => LIFECYCLE.has(verb)),
    spec: (role, serial = 1) =>
      containerSpecFor({
        role,
        image: BASE,
        labels: { work_id: WORK, run_id: RUN, round: 1 },
        serial,
        limits: limitsFor(role),
      }),
    golden: (role) => goldenFor({ role, image, forbidden: FORBIDDEN }),
    isolationEvents: () => ledger.readVerified().filter((event) => event.type === "isolation.measured"),
    run: () => loadRunIsolation(itemDir, scope, ledger.readVerified()),
  };
}

/** One way a daemon-reported container can differ from its golden, and exactly what the evaluator must say. */
export interface Deviation {
  name: string;
  edit: (doc: InspectDoc) => void;
  codes: readonly ViolationCode[];
}

const bind =
  (source: string, destination = "/srv/x") =>
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

export const DEVIATIONS: readonly Deviation[] = [
  { name: "an extra bind mount", edit: bind("/srv/data"), codes: ["unexpected_mount"] },
  { name: "the vault as a bind source", edit: bind(VAULT), codes: ["unexpected_mount", "forbidden_mount_source"] },
  { name: "the user's home as a bind source", edit: bind(HOME), codes: ["unexpected_mount", "forbidden_mount_source"] },
  {
    name: "the docker socket",
    edit: bind("/var/run/docker.sock", "/var/run/docker.sock"),
    codes: ["docker_socket_mounted", "unexpected_mount"],
  },
  { name: "a bridge network", edit: host("NetworkMode", "bridge"), codes: ["network_not_none"] },
  { name: "privileged mode", edit: host("Privileged", true), codes: ["privileged"] },
  { name: "a missing no-new-privileges", edit: host("SecurityOpt", []), codes: ["no_new_privileges_missing"] },
  { name: "another runtime", edit: host("Runtime", "nvidia"), codes: ["runtime_unexpected"] },
  { name: "a root user", edit: (doc) => void (doc.Config.User = "0:0"), codes: ["root_user"] },
  {
    name: "an extra environment name",
    edit: (doc) => void (doc.Config.Env = [...(doc.Config.Env ?? []), "API_TOKEN=not-read"]),
    codes: ["unexpected_env_name"],
  },
];

/** A `docker inspect` document of a golden container of `role`, written from the golden values and not from any argv. */
export function goldenInspectDoc(role: ContainerRole): InspectDoc {
  const destinations = {
    sut: ["/tmp", "/scratch"],
    harness: ["/tmp", "/state"],
    workcopy: ["/tmp", "/work"],
    implementer: ["/tmp", "/work", "/agent"],
    author: ["/tmp", "/in", "/out", "/agent"],
  }[role];
  return {
    Id: "c0ffee".padEnd(64, "0"),
    Config: { Image: BASE, User: "65532:65532", Env: ["PATH=/usr/bin", "LC_ALL=C"] },
    Mounts: destinations.map((destination) => ({
      Type: "tmpfs",
      Source: "",
      Destination: destination,
      Mode: "",
      RW: true,
    })),
    HostConfig: {
      Binds: null,
      Privileged: false,
      CapAdd: null,
      CapDrop: ["ALL"],
      NetworkMode: role === "implementer" || role === "author" ? "bridge" : "none",
      PidMode: "",
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges"],
      Devices: null,
      IpcMode: "private",
      UTSMode: "",
      UsernsMode: "",
      CgroupnsMode: "private",
      VolumesFrom: null,
      Sysctls: {},
      Runtime: "runc",
      Tmpfs: Object.fromEntries(destinations.map((destination) => [destination, "rw,nosuid,nodev"])),
    },
  };
}
