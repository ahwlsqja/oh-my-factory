// covers: S5.5.judge-two-container
import { describe, expect, it } from "vitest";
import {
  buildArgv,
  contextInspectArgv,
  createArgv,
  execArgv,
  imageInspectArgv,
  infoArgv,
  inspectArgv,
  pullArgv,
  removeArgv,
  startArgv,
} from "../../src/container/argv.js";
import { pinnedImage } from "../../src/container/image-ref.js";
import type { ContainerSpec, TmpfsSpec } from "../../src/container/spec.js";
import {
  FIXTURE_RUN_ID,
  FIXTURE_WORK_ID,
  HARNESS_BASE,
  SUT_BASE,
  labelsFor,
  specFor,
} from "../helpers/container-fixture.js";

const JUDGE_ROLES = ["sut", "harness", "workcopy"] as const;
type JudgeRole = (typeof JUDGE_ROLES)[number];

// W-judge-argv-golden (argv half): every container OMF creates comes from one reviewed argv function, pinned byte for
// byte, and the spec type cannot express a mount, a volume, a privilege or a network (spec §7, M3f-D2). What the daemon
// then reports about the container is judged by the per-run measurement.
const HEAD = (role: JudgeRole): string =>
  `--context colima-omf-m3f create --name omf-${role}-${FIXTURE_RUN_ID}-1-1 --pull never --label omf.owner=omf --label omf.work=${FIXTURE_WORK_ID} --label omf.run=${FIXTURE_RUN_ID} --label omf.round=1 --label omf.role=${role} --network none --cap-drop ALL --security-opt no-new-privileges --read-only --user 65532:65532 --pids-limit 256 --memory 512m --cpus 1 --stop-timeout 1 --env LC_ALL=C`;
const OWNED = "nosuid,nodev,uid=65532,gid=65532";

const GOLDEN: Record<JudgeRole, string> = {
  sut: `${HEAD("sut")} --tmpfs /tmp:rw,size=64m,${OWNED} --tmpfs /scratch:rw,size=64m,${OWNED} --entrypoint sleep ${SUT_BASE} 1703`,
  harness: `${HEAD("harness")} --tmpfs /tmp:rw,size=64m,${OWNED} --tmpfs /state:rw,size=16m,${OWNED} --entrypoint sleep ${HARNESS_BASE} 578633`,
  workcopy: `${HEAD("workcopy")} --tmpfs /tmp:rw,size=64m,${OWNED} --tmpfs /work:rw,size=256m,nosuid,nodev,exec,uid=65532,gid=65532 --entrypoint sleep ${SUT_BASE} 32933`,
};

describe("the golden create argv", () => {
  it.each(JUDGE_ROLES)("%s: createArgv is pinned byte for byte", (role) => {
    expect(createArgv(specFor(role), "colima-omf-m3f").join(" ")).toBe(GOLDEN[role]);
  });

  it.each(JUDGE_ROLES)("%s: no element holds whitespace, so the joined golden is faithful", (role) => {
    expect(createArgv(specFor(role), "colima-omf-m3f").filter((element) => /\s/.test(element))).toEqual([]);
  });

  it("starts with --context only when a context is given", () => {
    const withContext = createArgv(specFor("sut"), "colima-omf-m3f");
    expect(withContext.slice(0, 3)).toEqual(["--context", "colima-omf-m3f", "create"]);
    expect(createArgv(specFor("sut"), null)).toEqual(withContext.slice(2));
  });
});

/** Every builder over a product space of roles, contexts, images, tmpfs sets and limits. */
function productSpace(): string[][] {
  const all: string[][] = [];
  const images = [pinnedImage(SUT_BASE), pinnedImage(HARNESS_BASE), `sha256:${"e".repeat(64)}`];
  const tmpfsSets: TmpfsSpec[][] = [
    [],
    [{ destination: "/tmp", size_mb: 1, exec: false, owned: false }],
    [
      { destination: "/work", size_mb: 4096, exec: true, owned: true },
      { destination: "/state", size_mb: 16, exec: true, owned: false },
    ],
  ];
  const limitSets = [
    { memory_mb: 16, cpus: 0.1, pids: 1 },
    { memory_mb: 65536, cpus: 64, pids: 32768 },
  ];
  for (const context of [null, "colima-omf-m3f", "a"]) {
    for (const role of JUDGE_ROLES) {
      for (const image of images) {
        for (const tmpfs of tmpfsSets) {
          for (const limits of limitSets) {
            all.push(createArgv({ ...specFor(role), image: image as ContainerSpec["image"], tmpfs, limits }, context));
          }
        }
      }
      const { name } = specFor(role);
      const tag = `omf-${role === "harness" ? "harness" : "sut"}:x-1`;
      all.push(
        startArgv(name, context),
        inspectArgv(name, context),
        removeArgv([name], context),
        execArgv(name, { argv: ["true"], workdir: "/scratch", env: { HOME: "/scratch" }, stdin: true }, context),
        buildArgv({ contextDir: "/work/ctx", tag, labels: labelsFor(role), contextHash: "f".repeat(64) }, context),
      );
    }
    all.push(pullArgv(pinnedImage(SUT_BASE), context), infoArgv(context), imageInspectArgv(SUT_BASE, context));
  }
  all.push(contextInspectArgv("colima-omf-m3f"));
  return all;
}

const FORBIDDEN =
  /^(--(mount|volume|privileged|cap-add|device|pid|ipc|userns|volumes-from|publish|link|net)(=|$)|-v$|-p$)/;

describe("no builder can emit a mount, a privilege or a network other than none", () => {
  it("holds over the whole product space of builders", () => {
    const space = productSpace();
    expect(space.length).toBeGreaterThan(100);
    for (const argv of space) {
      expect(argv.filter((element) => FORBIDDEN.test(element))).toEqual([]);
      expect(argv.filter((element) => element.includes("docker.sock"))).toEqual([]);
      argv.forEach((element, index) => {
        if (element === "--network") expect(argv[index + 1]).toBe("none");
        expect(element.startsWith("--network=")).toBe(false);
      });
    }
  });

  it("the spec type has no field that could carry one", () => {
    type Absent<K extends string> = K extends keyof ContainerSpec ? false : true;
    const absent: [
      Absent<"mounts">,
      Absent<"volumes">,
      Absent<"privileged">,
      Absent<"network">,
      Absent<"cap_add">,
      Absent<"devices">,
      Absent<"env">,
    ] = [true, true, true, true, true, true, true];
    expect(absent.every(Boolean)).toBe(true);
    expect(Object.keys(specFor("sut")).sort()).toEqual(["image", "labels", "lifetime_s", "limits", "name", "tmpfs"]);
  });
});
