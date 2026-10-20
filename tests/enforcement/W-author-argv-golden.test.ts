import { describe, expect, it } from "vitest";
import { createArgv } from "../../src/container/argv.js";
import { containerSpecFor } from "../../src/container/golden.js";
import { type PinnedImage, pinnedImage } from "../../src/container/image-ref.js";
import {
  AUTHOR_FIXED_ENV,
  assertSpec,
  type ContainerSpec,
  ContainerSpecError,
  type ImageId,
  type RoleLimits,
  roleLimits,
  roleTmpfs,
} from "../../src/container/spec.js";
import { CONFIG_DEFAULTS } from "../../src/core/config.js";
import {
  AUTHOR_BASE,
  FIXTURE_AUTHOR_LIMITS,
  FIXTURE_RUN_ID,
  FIXTURE_WORK_ID,
  limitsFor,
  specFor,
} from "../helpers/container-fixture.js";

// covers: S5.3.author-container-argv
// covers: F6.author-vault-host-only
// W-author-argv-golden (create half): the author container comes from the same reviewed argv function as every other role,
// pinned byte for byte. It differs from a judge role in the network, the fixed environment and its tmpfs set, and from the
// implementer in the environment and the absence of any executable mount (spec §7). The key is not in it: it appears only as
// a name at exec time (W-secret-role-bound).
const NAME = `omf-author-${FIXTURE_RUN_ID}-1-1`;
const OWNED = "nosuid,nodev,uid=65532,gid=65532";
const FIXED_ENV = "--env HOME=/agent --env CODEX_HOME=/agent/codex --env NO_COLOR=1 --env OMF_TMP=/tmp";
const GOLDEN_CREATE = `--context colima-omf-m3f create --name ${NAME} --pull never --label omf.owner=omf --label omf.work=${FIXTURE_WORK_ID} --label omf.run=${FIXTURE_RUN_ID} --label omf.round=1 --label omf.role=author --network bridge --cap-drop ALL --security-opt no-new-privileges --read-only --user 65532:65532 --pids-limit 256 --memory 1024m --cpus 1 --stop-timeout 1 --init=false --env LC_ALL=C ${FIXED_ENV} --tmpfs /tmp:rw,size=64m,${OWNED} --tmpfs /in:rw,size=16m,${OWNED} --tmpfs /out:rw,size=16m,${OWNED} --tmpfs /agent:rw,size=128m,${OWNED} --entrypoint sleep ${AUTHOR_BASE} 765`;

const CLOSED_FLAGS = [
  "--cap-drop",
  "--context",
  "--cpus",
  "--entrypoint",
  "--env",
  "--init=false",
  "--label",
  "--memory",
  "--name",
  "--network",
  "--pids-limit",
  "--pull",
  "--read-only",
  "--security-opt",
  "--stop-timeout",
  "--tmpfs",
  "--user",
];
const FORBIDDEN =
  /^(--(mount|volume|privileged|cap-add|device|pid|ipc|userns|volumes-from|publish|link|net)(=|$)|-v$|-p$)/;

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof ContainerSpecError ? error.code : `other: ${String(error)}`;
  }
  return "no error";
};
const flagsOf = (argv: readonly string[]): string[] =>
  [...new Set(argv.filter((element) => element.startsWith("--")))].sort();
const labels = { work_id: FIXTURE_WORK_ID, run_id: FIXTURE_RUN_ID, round: 1 };

describe("the author create argv", () => {
  it("is pinned byte for byte", () => {
    expect(createArgv(specFor("author"), "colima-omf-m3f").join(" ")).toBe(GOLDEN_CREATE);
  });

  it("holds no element with whitespace, so the joined golden is faithful", () => {
    expect(createArgv(specFor("author"), "colima-omf-m3f").filter((element) => /\s/.test(element))).toEqual([]);
  });

  it("uses the flags of a judge role, with one --network and its value bridge", () => {
    const author = createArgv(specFor("author"), null);
    expect(flagsOf(author)).toEqual(flagsOf(createArgv(specFor("workcopy"), null)));
    expect(author.filter((element) => element === "--network")).toHaveLength(1);
    expect(author[author.indexOf("--network") + 1]).toBe("bridge");
  });

  it("mounts four tmpfs filesystems and none of them may execute", () => {
    const tmpfs = specFor("author").tmpfs;
    expect(tmpfs.map((mount) => [mount.destination, mount.exec, mount.owned])).toEqual([
      ["/tmp", false, true],
      ["/in", false, true],
      ["/out", false, true],
      ["/agent", false, true],
    ]);
    expect(tmpfs).toEqual(roleTmpfs("author", limitsFor("author")));
  });

  it("emits no flag outside the closed set and no secret over images, contexts, limits and tmpfs sizes", () => {
    const images: Array<PinnedImage | ImageId> = [pinnedImage(AUTHOR_BASE), `sha256:${"e".repeat(64)}` as ImageId];
    let count = 0;
    for (const context of [null, "colima-omf-m3f"]) {
      for (const image of images) {
        for (const memory_mb of [16, 65536]) {
          for (const size of [1, 4096]) {
            const author = {
              ...FIXTURE_AUTHOR_LIMITS,
              memory_mb,
              cpus: 0.5,
              pids_limit: 1,
              tmp_tmpfs_mb: size,
              in_tmpfs_mb: size,
              out_tmpfs_mb: size,
              agent_tmpfs_mb: size,
            };
            const spec = containerSpecFor({
              role: "author",
              image,
              labels,
              serial: 1,
              limits: { kind: "author", author },
            });
            const argv = createArgv(spec, context);
            count += 1;
            expect(argv.filter((element) => element.startsWith("--") && !CLOSED_FLAGS.includes(element))).toEqual([]);
            expect(argv.filter((element) => FORBIDDEN.test(element))).toEqual([]);
            expect(argv.filter((element) => element.includes("docker.sock") || /API_KEY/.test(element))).toEqual([]);
            expect(argv.filter((_element, at) => argv[at - 1] === "--network")).toEqual(["bridge"]);
            expect(argv.filter((_element, at) => argv[at - 1] === "--env")).toEqual([
              "LC_ALL=C",
              ...AUTHOR_FIXED_ENV.map(([name, value]) => `${name}=${value}`),
            ]);
          }
        }
      }
    }
    expect(count).toBe(16);
  });

  it("refuses limits of the wrong kind for the role", () => {
    const judge: RoleLimits = { kind: "judge", judge: CONFIG_DEFAULTS.judge };
    const image = pinnedImage(AUTHOR_BASE);
    expect(codeOf(() => containerSpecFor({ role: "author", image, labels, serial: 1, limits: judge }))).toBe(
      "invalid_limits",
    );
    expect(
      codeOf(() => containerSpecFor({ role: "author", image, labels, serial: 1, limits: limitsFor("implementer") })),
    ).toBe("invalid_limits");
    expect(codeOf(() => containerSpecFor({ role: "sut", image, labels, serial: 1, limits: limitsFor("author") }))).toBe(
      "invalid_limits",
    );
  });

  it("refuses a spec one step outside each bound and accepts one on it", () => {
    const base = specFor("author");
    const withLimits = (limits: Partial<ContainerSpec["limits"]>): ContainerSpec => ({
      ...base,
      limits: { ...base.limits, ...limits },
    });
    const withTmpfsSize = (size_mb: number): ContainerSpec => ({
      ...base,
      tmpfs: base.tmpfs.map((mount, at) => (at === 0 ? { ...mount, size_mb } : mount)),
    });
    const grid: Array<[string, ContainerSpec, "invalid_limits" | "invalid_tmpfs" | "ok"]> = [
      ["memory 15", withLimits({ memory_mb: 15 }), "invalid_limits"],
      ["memory 16", withLimits({ memory_mb: 16 }), "ok"],
      ["memory 65536", withLimits({ memory_mb: 65536 }), "ok"],
      ["memory 65537", withLimits({ memory_mb: 65537 }), "invalid_limits"],
      ["pids 0", withLimits({ pids: 0 }), "invalid_limits"],
      ["pids 1", withLimits({ pids: 1 }), "ok"],
      ["pids 32768", withLimits({ pids: 32768 }), "ok"],
      ["pids 32769", withLimits({ pids: 32769 }), "invalid_limits"],
      ["cpus 0", withLimits({ cpus: 0 }), "invalid_limits"],
      ["cpus 0.5", withLimits({ cpus: 0.5 }), "ok"],
      ["cpus 64", withLimits({ cpus: 64 }), "ok"],
      ["cpus 65", withLimits({ cpus: 65 }), "invalid_limits"],
      ["tmpfs 0", withTmpfsSize(0), "invalid_tmpfs"],
      ["tmpfs 1", withTmpfsSize(1), "ok"],
      ["tmpfs 4096", withTmpfsSize(4096), "ok"],
      ["tmpfs 4097", withTmpfsSize(4097), "invalid_tmpfs"],
    ];
    for (const [name, spec, want] of grid) {
      expect(
        codeOf(() => assertSpec(spec)),
        name,
      ).toBe(want === "ok" ? "no error" : want);
      expect(
        codeOf(() => createArgv(spec, null)),
        `${name} through createArgv`,
      ).toBe(want === "ok" ? "no error" : want);
    }
  });

  it("refuses the wrong limits kind for every role when asked for the limits directly", () => {
    const judge: RoleLimits = { kind: "judge", judge: CONFIG_DEFAULTS.judge };
    const implementer = limitsFor("implementer");
    const author = limitsFor("author");
    expect(roleLimits("author", limitsFor("author"))).toEqual({ memory_mb: 1024, cpus: 1, pids: 256 });
    expect(codeOf(() => roleLimits("author", judge))).toBe("invalid_limits");
    expect(codeOf(() => roleLimits("author", implementer))).toBe("invalid_limits");
    for (const role of ["harness", "workcopy", "sut"] as const) {
      expect(
        codeOf(() => roleLimits(role, author)),
        `${role} with author limits`,
      ).toBe("invalid_limits");
      expect(
        codeOf(() => roleTmpfs(role, author)),
        `${role} tmpfs with author limits`,
      ).toBe("invalid_limits");
    }
    expect(codeOf(() => roleLimits("implementer", author))).toBe("invalid_limits");
  });
});
