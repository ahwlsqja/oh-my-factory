import { describe, expect, it } from "vitest";
import {
  buildArgv,
  contextInspectArgv,
  createArgv,
  execArgv,
  imageInspectArgv,
  infoArgv,
  inspectArgv,
  listOwnedArgv,
  pullArgv,
  removeArgv,
  removeImageArgv,
  startArgv,
} from "../../src/container/argv.js";
import type { PinnedImage } from "../../src/container/image-ref.js";
import {
  type ContainerRole,
  ContainerSpecError,
  type ContainerSpecErrorCode,
  type ImageId,
  RUN_ID_RE,
  type TmpfsSpec,
  containerName,
} from "../../src/container/spec.js";
import { RUN_ID_PATTERN } from "../../src/work/w-events.js";
import { FIXTURE_RUN_ID, FIXTURE_WORK_ID, SUT_BASE, labelsFor, specFor } from "../helpers/container-fixture.js";

const sut = specFor("sut");
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof ContainerSpecError ? error.code : `other: ${String(error)}`;
  }
  return "no error";
};

describe("names and labels", () => {
  it("builds a name that matches the pattern and refuses a bad serial", () => {
    expect(containerName(labelsFor("harness", 2), 7)).toBe(`omf-harness-${FIXTURE_RUN_ID}-2-7`);
    expect(codeOf(() => containerName(labelsFor("sut"), -1))).toBe("invalid_name");
    expect(codeOf(() => containerName(labelsFor("sut"), 1.5))).toBe("invalid_name");
  });

  it("uses the same run id pattern as the W events", () => {
    expect(RUN_ID_RE.source).toBe(RUN_ID_PATTERN.source);
  });
});

describe("a bad spec or argument throws before any argv exists", () => {
  const withTmpfs = (tmpfs: TmpfsSpec[]) => () => createArgv({ ...sut, tmpfs }, null);
  const tmp = (size_mb: number): TmpfsSpec => ({ destination: "/tmp", size_mb, exec: false, owned: true });
  const bad: Array<[string, () => unknown, ContainerSpecErrorCode]> = [
    ["a name that is not an OMF name", () => createArgv({ ...sut, name: "omf-sut-x" }, null), "invalid_name"],
    ["a name of another role", () => createArgv({ ...sut, name: specFor("harness").name }, null), "invalid_name"],
    [
      "a malformed work id",
      () => createArgv({ ...sut, labels: { ...sut.labels, work_id: "w-x" } }, null),
      "invalid_label",
    ],
    ["a fractional round", () => createArgv({ ...sut, labels: { ...sut.labels, round: 1.5 } }, null), "invalid_label"],
    [
      "a role that is not a role",
      () => createArgv({ ...sut, labels: { ...sut.labels, role: "judge" as ContainerRole } }, null),
      "invalid_label",
    ],
    [
      "an image tag",
      () => createArgv({ ...sut, image: "example.test/img:latest" as PinnedImage }, null),
      "invalid_image",
    ],
    [
      "a tmpfs outside the closed set",
      withTmpfs([{ ...tmp(1), destination: "/etc" as TmpfsSpec["destination"] }]),
      "invalid_tmpfs",
    ],
    ["the same tmpfs twice", withTmpfs([tmp(1), tmp(2)]), "invalid_tmpfs"],
    ["a zero-size tmpfs", withTmpfs([tmp(0)]), "invalid_tmpfs"],
    [
      "too little memory",
      () => createArgv({ ...sut, limits: { ...sut.limits, memory_mb: 8 } }, null),
      "invalid_limits",
    ],
    [
      "a cpu count in exponent form",
      () => createArgv({ ...sut, limits: { ...sut.limits, cpus: 1e-7 } }, null),
      "invalid_limits",
    ],
    ["a context that looks like a flag", () => startArgv(sut.name, "--privileged"), "invalid_context"],
    ["rm with a name that is not an OMF name", () => removeArgv(["x; rm"], null), "invalid_name"],
    ["an exec with no command", () => execArgv(sut.name, { argv: [], stdin: false }, null), "invalid_exec"],
    ["an exec element holding NUL", () => execArgv(sut.name, { argv: ["a\0b"], stdin: false }, null), "invalid_exec"],
    [
      "a relative exec workdir",
      () => execArgv(sut.name, { argv: ["a"], workdir: "scratch", stdin: false }, null),
      "invalid_exec",
    ],
    [
      "a build tag that is not an OMF tag",
      () => buildArgv({ contextDir: "/work/ctx", tag: "evil:latest", labels: labelsFor("sut") }, null),
      "invalid_build",
    ],
    [
      "a relative build context",
      () => buildArgv({ contextDir: "ctx", tag: "omf-sut:x-1", labels: labelsFor("sut") }, null),
      "invalid_build",
    ],
    ["pulling a tag", () => pullArgv("example.test/img:latest" as PinnedImage, null), "invalid_image"],
  ];

  it.each(bad)("%s", (_label, build, code) => {
    expect(codeOf(build)).toBe(code);
  });
});

describe("execArgv", () => {
  it("puts scenario data after the container name, verbatim, one element each", () => {
    const hostile = ["--privileged", "-v /:/host", "; rm -rf /", "$(x)", "line\nbreak", "--network=host", ""];
    const argv = execArgv(
      sut.name,
      { argv: hostile, workdir: "/scratch", env: { HOME: "/scratch", TMPDIR: "/scratch" }, stdin: true },
      "colima-omf-m3f",
    );
    const at = argv.indexOf(sut.name);
    expect(argv.slice(0, at)).toEqual([
      "--context",
      "colima-omf-m3f",
      "exec",
      "-i",
      "--workdir",
      "/scratch",
      "--env",
      "HOME=/scratch",
      "--env",
      "TMPDIR=/scratch",
    ]);
    expect(argv.slice(at + 1)).toEqual(hostile);
  });

  it("sends stdin only through the stdin channel: -i is the whole argv footprint", () => {
    expect(execArgv(sut.name, { argv: ["cat"], stdin: true }, null)).toEqual(["exec", "-i", sut.name, "cat"]);
    expect(execArgv(sut.name, { argv: ["cat"], stdin: false }, null)).toEqual(["exec", sut.name, "cat"]);
  });
});

describe("the other builders", () => {
  it("pins their shapes", () => {
    expect(startArgv(sut.name, "c")).toEqual(["--context", "c", "start", sut.name]);
    expect(inspectArgv(sut.name, "c")).toEqual(["--context", "c", "container", "inspect", sut.name]);
    expect(removeArgv([sut.name], null)).toEqual(["rm", "--force", "--volumes", sut.name]);
    expect(infoArgv("c")).toEqual(["--context", "c", "info", "--format", "{{.ServerVersion}}"]);
    expect(contextInspectArgv("c")).toEqual(["context", "inspect", "c"]);
    expect(imageInspectArgv(SUT_BASE, "c")).toEqual(["--context", "c", "image", "inspect", SUT_BASE]);
    expect(pullArgv(sut.image as PinnedImage, "c")).toEqual(["--context", "c", "pull", "--quiet", SUT_BASE]);
  });

  it("builds an image with no network, no pull, no cache and the OMF labels", () => {
    const argv = buildArgv(
      { contextDir: "/work/ctx", tag: "omf-harness:abc", labels: labelsFor("harness"), contextHash: "f".repeat(64) },
      "c",
    );
    expect(argv).toEqual([
      "--context",
      "c",
      "build",
      "--network",
      "none",
      "--pull=false",
      "--no-cache",
      "--label",
      "omf.owner=omf",
      "--label",
      `omf.work=${FIXTURE_WORK_ID}`,
      "--label",
      `omf.run=${FIXTURE_RUN_ID}`,
      "--label",
      "omf.round=1",
      "--label",
      "omf.role=harness",
      "--label",
      `omf.context=${"f".repeat(64)}`,
      "--tag",
      "omf-harness:abc",
      "/work/ctx",
    ]);
  });
});

describe("listing and image removal", () => {
  it("lists containers and images owned by OMF, optionally for one run, with fixed formats", () => {
    expect(listOwnedArgv("container", null, "ctx")).toEqual([
      "--context",
      "ctx",
      "ps",
      "--all",
      "--filter",
      "label=omf.owner=omf",
      "--format",
      '{{.Names}}\t{{.Label "omf.run"}}\t{{.Label "omf.work"}}',
    ]);
    expect(listOwnedArgv("container", "run-1", null)).toEqual([
      "ps",
      "--all",
      "--filter",
      "label=omf.owner=omf",
      "--filter",
      "label=omf.run=run-1",
      "--format",
      '{{.Names}}\t{{.Label "omf.run"}}\t{{.Label "omf.work"}}',
    ]);
    expect(listOwnedArgv("image", null, "ctx")).toEqual([
      "--context",
      "ctx",
      "image",
      "ls",
      "--filter",
      "label=omf.owner=omf",
      "--format",
      "{{.Repository}}:{{.Tag}}",
    ]);
  });

  it("refuses an unsafe run id and removes only OMF image names or ids", () => {
    expect(() => listOwnedArgv("container", "a b", null)).toThrow();
    expect(() => listOwnedArgv("container", "--all", null)).toThrow();
    expect(removeImageArgv("omf-sut:run-1-1" as ImageId, "ctx")).toEqual([
      "--context",
      "ctx",
      "image",
      "rm",
      "--force",
      "omf-sut:run-1-1",
    ]);
    expect(removeImageArgv(`sha256:${"a".repeat(64)}` as ImageId, null)).toEqual([
      "image",
      "rm",
      "--force",
      `sha256:${"a".repeat(64)}`,
    ]);
    expect(() => removeImageArgv("alpine:3" as ImageId, null)).toThrow();
    expect(() => removeImageArgv("-f" as ImageId, null)).toThrow();
  });
});

describe("PID 1 of every container is the idle sleep, never docker-init", () => {
  // The sleep is PID 1 and a candidate can still end it (it can install the `sleep` the PATH finds, or push PID 1 into an OOM
  // kill), which is why a stopped container is attributed by `stopCause` and not assumed to be the host's. A daemon configured
  // with `init: true` would put docker-init at PID 1 with the sleep as a killable child, so every create says --init=false and the
  // measurement reads HostConfig.Init back against the golden value false.
  it.each(["sut", "harness", "workcopy", "implementer", "author"] as const)("%s: sleep, --init=false", (role) => {
    const argv = createArgv(specFor(role), null);
    expect(argv.filter((element) => element.startsWith("--init"))).toEqual(["--init=false"]);
    const entry = argv.indexOf("--entrypoint");
    expect(argv.slice(entry, entry + 2)).toEqual(["--entrypoint", "sleep"]);
    // the image and the lifetime in seconds follow the entrypoint, and nothing after them
    expect(argv).toHaveLength(entry + 4);
    expect(argv[entry + 3]).toMatch(/^[0-9]+$/);
  });
});
