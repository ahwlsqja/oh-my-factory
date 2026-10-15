import { describe, expect, it } from "vitest";
import { createArgv, execArgv } from "../../src/container/argv.js";
import { containerSpecFor } from "../../src/container/golden.js";
import { type PinnedImage, pinnedImage } from "../../src/container/image-ref.js";
import {
  ContainerSpecError,
  IMPLEMENTER_FIXED_ENV,
  type ImageId,
  type RoleLimits,
  roleTmpfs,
} from "../../src/container/spec.js";
import { CONFIG_DEFAULTS } from "../../src/core/config.js";
import {
  FIXTURE_IMPLEMENTER_LIMITS,
  FIXTURE_RUN_ID,
  FIXTURE_WORK_ID,
  IMPLEMENTER_BASE,
  limitsFor,
  specFor,
} from "../helpers/container-fixture.js";

// W-implementer-argv-golden (create half): the implementer container comes from the same reviewed argv function as every
// other role, pinned byte for byte. It differs from a judge role only in the network value, the fixed environment and its
// tmpfs set (spec §7). Every other role's argv stays pinned in W-judge-argv-golden, which this task leaves unchanged.
const NAME = `omf-implementer-${FIXTURE_RUN_ID}-1-1`;
const OWNED = "nosuid,nodev,uid=65532,gid=65532";
const FIXED_ENV =
  "--env HOME=/agent --env CLAUDE_CONFIG_DIR=/agent/claude --env DISABLE_AUTOUPDATER=1 --env DISABLE_TELEMETRY=1 --env CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 --env NO_COLOR=1 --env OMF_TMP=/tmp --env GIT_AUTHOR_NAME=omf-implementer --env GIT_AUTHOR_EMAIL=omf-implementer@invalid --env GIT_COMMITTER_NAME=omf-implementer --env GIT_COMMITTER_EMAIL=omf-implementer@invalid";
const GOLDEN_CREATE = `--context colima-omf-m3f create --name ${NAME} --pull never --label omf.owner=omf --label omf.work=${FIXTURE_WORK_ID} --label omf.run=${FIXTURE_RUN_ID} --label omf.round=1 --label omf.role=implementer --network bridge --cap-drop ALL --security-opt no-new-privileges --read-only --user 65532:65532 --pids-limit 512 --memory 2048m --cpus 2 --stop-timeout 1 --env LC_ALL=C ${FIXED_ENV} --tmpfs /tmp:rw,size=256m,${OWNED} --tmpfs /work:rw,size=1024m,nosuid,nodev,exec,uid=65532,gid=65532 --tmpfs /agent:rw,size=256m,${OWNED} --entrypoint sleep ${IMPLEMENTER_BASE} 2147483647`;

const CLOSED_FLAGS = [
  "--cap-drop",
  "--context",
  "--cpus",
  "--entrypoint",
  "--env",
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

describe("the implementer create argv", () => {
  it("is pinned byte for byte", () => {
    expect(createArgv(specFor("implementer"), "colima-omf-m3f").join(" ")).toBe(GOLDEN_CREATE);
  });

  it("holds no element with whitespace, so the joined golden is faithful", () => {
    expect(createArgv(specFor("implementer"), "colima-omf-m3f").filter((element) => /\s/.test(element))).toEqual([]);
  });

  it("uses the flags of a judge role, with one --network and its value bridge", () => {
    const implementer = createArgv(specFor("implementer"), null);
    expect(flagsOf(implementer)).toEqual(flagsOf(createArgv(specFor("workcopy"), null)));
    expect(implementer.filter((element) => element === "--network")).toHaveLength(1);
    expect(implementer[implementer.indexOf("--network") + 1]).toBe("bridge");
  });

  it("mounts tmpfs only, and only /work may execute", () => {
    const tmpfs = specFor("implementer").tmpfs;
    expect(tmpfs.map((mount) => [mount.destination, mount.exec, mount.owned])).toEqual([
      ["/tmp", false, true],
      ["/work", true, true],
      ["/agent", false, true],
    ]);
    expect(tmpfs).toEqual(roleTmpfs("implementer", limitsFor("implementer")));
  });

  it("emits no flag outside the closed set over images, contexts, limits and tmpfs sizes", () => {
    const images: Array<PinnedImage | ImageId> = [pinnedImage(IMPLEMENTER_BASE), `sha256:${"e".repeat(64)}` as ImageId];
    let count = 0;
    for (const context of [null, "colima-omf-m3f"]) {
      for (const image of images) {
        for (const memory_mb of [16, 65536]) {
          for (const size of [1, 4096]) {
            const implementer = {
              ...FIXTURE_IMPLEMENTER_LIMITS,
              memory_mb,
              cpus: 0.5,
              pids_limit: 1,
              tmp_tmpfs_mb: size,
              work_tmpfs_mb: size,
              agent_tmpfs_mb: size,
            };
            const spec = containerSpecFor({
              role: "implementer",
              image,
              labels,
              serial: 1,
              limits: { kind: "implementer", implementer },
            });
            const argv = createArgv(spec, context);
            count += 1;
            expect(argv.filter((element) => element.startsWith("--") && !CLOSED_FLAGS.includes(element))).toEqual([]);
            expect(argv.filter((element) => FORBIDDEN.test(element))).toEqual([]);
            expect(argv.filter((element) => element.includes("docker.sock"))).toEqual([]);
            expect(argv.filter((_element, at) => argv[at - 1] === "--network")).toEqual(["bridge"]);
            expect(argv.filter((_element, at) => argv[at - 1] === "--env")).toEqual([
              "LC_ALL=C",
              ...IMPLEMENTER_FIXED_ENV.map(([name, value]) => `${name}=${value}`),
            ]);
          }
        }
      }
    }
    expect(count).toBe(16);
  });

  it("refuses limits of the wrong kind for the role", () => {
    const judge: RoleLimits = { kind: "judge", judge: CONFIG_DEFAULTS.judge };
    const image = pinnedImage(IMPLEMENTER_BASE);
    expect(codeOf(() => containerSpecFor({ role: "implementer", image, labels, serial: 1, limits: judge }))).toBe(
      "invalid_limits",
    );
    expect(
      codeOf(() => containerSpecFor({ role: "sut", image, labels, serial: 1, limits: limitsFor("implementer") })),
    ).toBe("invalid_limits");
    expect(codeOf(() => roleTmpfs("implementer", judge))).toBe("invalid_limits");
  });
});

describe("the implementer exec argv", () => {
  it("is pinned byte for byte; the secret is a name-only flag and nothing else is added", () => {
    const secret = { argv: ["claude", "-p"], workdir: "/work", stdin: true, secret: "ANTHROPIC_API_KEY" } as const;
    expect(execArgv(NAME, secret, "colima-omf-m3f").join(" ")).toBe(
      `--context colima-omf-m3f exec -i --workdir /work --env ANTHROPIC_API_KEY ${NAME} claude -p`,
    );
    expect(
      execArgv(NAME, { argv: ["git", "status"], workdir: "/work", stdin: false }, "colima-omf-m3f").join(" "),
    ).toBe(`--context colima-omf-m3f exec --workdir /work ${NAME} git status`);
  });
});
