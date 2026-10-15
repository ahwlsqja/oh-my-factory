import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { schemaUrl, validate } from "../../src/core/schema.js";
import { canonicalize, sha256Hex } from "../../src/core/canonical-json.js";
import { evaluateStage, hostStage, measurementHash, pathRelation } from "../../src/isolation/evaluate.js";
import type { ContainerChecks, ContainerFacts, MountFact } from "../../src/isolation/types.js";
import type { StageGolden } from "../../src/isolation/evaluate.js";
import { GOLDEN_STAGE, HOME, OMF_HOME, SCENARIOS, WORKTREE, goldenObserved } from "../helpers/inspect-fixtures.js";
import {
  type IsolationLevel,
  type IsolationStage,
  type StageMeasurement,
  type ViolationCode,
  ISOLATION_LEVELS,
  ISOLATION_STAGES,
  VIOLATION_CODES,
  compareLevel,
  minLevel,
  runIsolation,
} from "../../src/isolation/types.js";

/** A measurement with no facts: enough for the ordering and the minimum, which read only `level` and `violations`. */
function measurement(
  stage: IsolationStage,
  level: IsolationLevel,
  violations: ViolationCode[] = [],
  shaChar = "a",
): StageMeasurement {
  return {
    stage,
    mode: "container",
    measured_at: "2026-10-12T00:00:00.000Z",
    facts: null,
    checks: null,
    level,
    violations,
    facts_sha256: shaChar.repeat(64),
  };
}

const RUN = "r-20261012T000000Z-ab12";

describe("level order", () => {
  it("ranks unmeasured below L1 below L2 below L3", () => {
    const ladder = ["unmeasured", "L1", "L2", "L3"] as const;
    for (let i = 0; i < ladder.length; i++) {
      for (let j = 0; j < ladder.length; j++) {
        expect(compareLevel(ladder[i]!, ladder[j]!)).toBe(i < j ? -1 : i > j ? 1 : 0);
      }
    }
  });

  it("takes the minimum, and an empty list is unmeasured", () => {
    expect(minLevel([])).toBe("unmeasured");
    expect(minLevel(["L2", "L3"])).toBe("L2");
    expect(minLevel(["L2", "L1", "L3"])).toBe("L1");
    expect(minLevel(["L2", "unmeasured"])).toBe("unmeasured");
  });

  it("lists the levels and stages the schema and the sequencer rely on", () => {
    expect(ISOLATION_LEVELS).toEqual(["L1", "L2", "L3"]);
    expect(ISOLATION_STAGES).toEqual(["author", "implementer", "sut", "harness"]);
  });
});

describe("runIsolation", () => {
  it("is unmeasured and incomplete with no measurement", () => {
    expect(runIsolation(RUN, [])).toEqual({
      run_id: RUN,
      stages: { author: null, implementer: null, sut: null, harness: null },
      level: "unmeasured",
      complete: false,
    });
  });

  it("stays unmeasured until all four stages are measured, even when every measured stage is L2", () => {
    const three = ISOLATION_STAGES.slice(0, 3).map((stage) => measurement(stage, "L2"));
    expect(runIsolation(RUN, three)).toMatchObject({ level: "unmeasured", complete: false });
    const four = ISOLATION_STAGES.map((stage) => measurement(stage, "L2"));
    expect(runIsolation(RUN, four)).toMatchObject({ level: "L2", complete: true });
  });

  it("takes the lowest stage as the run level", () => {
    const all = ISOLATION_STAGES.map((stage) => measurement(stage, stage === "sut" ? "L1" : "L2", stage === "sut" ? ["host_network"] : []));
    const result = runIsolation(RUN, all);
    expect(result.level).toBe("L1");
    expect(result.stages.sut).toEqual({ level: "L1", measurements: 1, violations: ["host_network"], facts_sha256s: ["a".repeat(64)] });
  });

  it("keeps the minimum over rounds: an L1 container in round 1 is not healed by an L2 container in round 2", () => {
    const rounds = [
      measurement("sut", "L1", ["privileged", "cap_added"], "1"),
      measurement("sut", "L2", [], "2"),
      measurement("sut", "L1", ["cap_added"], "3"),
      measurement("sut", "L2", [], "2"),
    ];
    const all = [...rounds, ...ISOLATION_STAGES.filter((stage) => stage !== "sut").map((stage) => measurement(stage, "L2"))];
    const sut = runIsolation(RUN, all).stages.sut;
    expect(sut).toEqual({
      level: "L1",
      measurements: 4,
      violations: ["privileged", "cap_added"],
      facts_sha256s: ["1".repeat(64), "2".repeat(64), "3".repeat(64)],
    });
  });
});

describe("isolation.schema.json", () => {
  const document = (): Record<string, unknown> => ({
    schema_version: 1,
    run_id: RUN,
    stages: Object.fromEntries(ISOLATION_STAGES.map((stage) => [stage, [measurement(stage, "L2")]])),
    level: "L2",
  });

  it("accepts a document built from measurements", () => {
    expect(validate("isolation.schema.json", document())).toEqual({ ok: true });
  });

  it("rejects an unknown violation code, a bad level, an extra key and a missing stage", () => {
    const badCode = document();
    (badCode.stages as Record<string, StageMeasurement[]>).sut = [{ ...measurement("sut", "L1"), violations: ["made_up"] as unknown as ViolationCode[] }];
    expect(validate("isolation.schema.json", badCode).ok).toBe(false);
    expect(validate("isolation.schema.json", { ...document(), level: "L9" }).ok).toBe(false);
    expect(validate("isolation.schema.json", { ...document(), note: "hi" }).ok).toBe(false);
    const missing = document();
    delete (missing.stages as Record<string, unknown>).harness;
    expect(validate("isolation.schema.json", missing).ok).toBe(false);
  });

  it("closes the same lists the TypeScript types close", () => {
    const schema = JSON.parse(readFileSync(schemaUrl("isolation.schema.json"), "utf8")) as {
      properties: { stages: { properties: Record<string, unknown> }; level: { enum: string[] } };
      $defs: { violation_code: { enum: string[] } };
    };
    expect(schema.$defs.violation_code.enum).toEqual([...VIOLATION_CODES]);
    expect(Object.keys(schema.properties.stages.properties)).toEqual([...ISOLATION_STAGES]);
    expect(schema.properties.level.enum).toEqual(["unmeasured", ...ISOLATION_LEVELS]);
  });
});

const AT = new Date("2026-10-12T00:00:00.000Z");

/** The violations for the golden container with `facts` and `checks` patched. */
function codes(facts: Partial<ContainerFacts> = {}, checks: Partial<ContainerChecks> = {}, golden: StageGolden = GOLDEN_STAGE): ViolationCode[] {
  const base = goldenObserved();
  return evaluateStage("implementer", { facts: { ...base.facts, ...facts }, checks: { ...base.checks, ...checks } }, golden, AT).violations;
}

const bind = (source: string, destination: string, read_only = false): MountFact => ({ type: "bind", source, destination, read_only });
/** The golden mounts without the one at `destination`, so a test can replace it. */
const mountsExcept = (destination: string): MountFact[] => goldenObserved().facts.mounts.filter((mount) => mount.destination !== destination);

describe("evaluateStage", () => {
  it("gives L2 and no violation for the golden container, including worktree and scenario mounts under the OMF home", () => {
    const measurement = evaluateStage("implementer", goldenObserved(), GOLDEN_STAGE, AT);
    expect(measurement).toMatchObject({ stage: "implementer", mode: "container", level: "L2", violations: [], measured_at: AT.toISOString() });
    expect(measurement.facts).toEqual(goldenObserved().facts);
    expect(measurement.facts_sha256).toBe(measurementHash("implementer", "container", measurement.facts, measurement.checks));
    expect(validate("isolation.schema.json", {
      schema_version: 1,
      run_id: RUN,
      stages: { author: [], implementer: [measurement], sut: [], harness: [] },
      level: "L2",
    })).toEqual({ ok: true });
  });

  it("hashes the facts, not the clock", () => {
    const first = evaluateStage("implementer", goldenObserved(), GOLDEN_STAGE, AT);
    const later = evaluateStage("implementer", goldenObserved(), GOLDEN_STAGE, new Date("2027-01-01T00:00:00.000Z"));
    const other = evaluateStage("implementer", { ...goldenObserved(), facts: { ...goldenObserved().facts, image: "other:2" } }, GOLDEN_STAGE, AT);
    expect(later.facts_sha256).toBe(first.facts_sha256);
    expect(other.facts_sha256).not.toBe(first.facts_sha256);
  });

  type Row = [string, Partial<ContainerFacts>, Partial<ContainerChecks>, ViolationCode];
  const SINGLE: Row[] = [
    ["privileged", { privileged: true }, {}, "privileged"],
    ["cap added", { cap_add: ["NET_ADMIN"] }, {}, "cap_added"],
    ["caps not dropped", { cap_drop: [] }, {}, "caps_not_dropped"],
    ["host network", { network_mode: "host" }, {}, "host_network"],
    ["bridge when none is required", { network_mode: "bridge" }, {}, "network_not_none"],
    ["host pid", { pid_mode: "host" }, {}, "host_pid"],
    ["empty user is root", { user: "" }, {}, "root_user"],
    ["uid 0 is root", { user: "0:0" }, {}, "root_user"],
    ["writable rootfs", { read_only_rootfs: false }, {}, "rootfs_writable"],
    ["extra env name", { env_names: ["HOME", "OMF_STAGE", "PATH", "AWS_SECRET_ACCESS_KEY"] }, {}, "unexpected_env_name"],
    ["vendor binary", {}, { vendor_binaries: ["codex"] }, "vendor_binary_present"],
    ["credential path", {}, { credential_paths: ["/home/agent/.codex/auth.json"] }, "credential_present"],
    ["socket found in the container", {}, { docker_socket_present: true }, "docker_socket_present"],
    ["no-new-privileges missing", { security_opt: [] }, {}, "no_new_privileges_missing"],
    ["no-new-privileges set false", { security_opt: ["no-new-privileges:false"] }, {}, "no_new_privileges_missing"],
    ["seccomp unconfined", { security_opt: ["no-new-privileges", "seccomp=unconfined"] }, {}, "security_opt_unconfined"],
    ["apparmor unconfined", { security_opt: ["no-new-privileges", "apparmor:unconfined"] }, {}, "security_opt_unconfined"],
    ["device mapped", { devices: ["/dev/fuse"] }, {}, "device_mapped"],
    ["pid joined to another container", { pid_mode: "container:abc" }, {}, "host_pid"],
    ["ipc joined to another container", { ipc_mode: "container:abc" }, {}, "host_ipc"],
    ["zero-padded uid 0 is root", { user: "00" }, {}, "root_user"],
    ["signed uid 0 is root", { user: "+0:0" }, {}, "root_user"],
    ["systempaths unconfined", { security_opt: ["no-new-privileges", "systempaths=unconfined"] }, {}, "security_opt_unconfined"],
    ["label disabled", { security_opt: ["no-new-privileges", "label=disable"] }, {}, "security_opt_unconfined"],
    ["custom seccomp profile", { security_opt: ["no-new-privileges", "seccomp=/tmp/open.json"] }, {}, "security_opt_unconfined"],
    ["host ipc", { ipc_mode: "host" }, {}, "host_ipc"],
    ["host uts", { uts_mode: "host" }, {}, "host_uts"],
    ["host user namespace", { userns_mode: "host" }, {}, "userns_host"],
    ["volumes from", { volumes_from: ["other"] }, {}, "volumes_from"],
    ["sysctl set", { sysctls: ["net.ipv4.ip_forward"] }, {}, "sysctl_set"],
    ["unexpected runtime", { runtime: "runsc" }, {}, "runtime_unexpected"],
  ];
  it.each(SINGLE)("%s gives exactly one violation", (_name, facts, checks, code) => {
    expect(codes(facts, checks)).toEqual([code]);
  });

  it("accepts a bridge network when the stage pins bridge", () => {
    expect(codes({ network_mode: "bridge" }, {}, { ...GOLDEN_STAGE, network: "bridge" })).toEqual([]);
    expect(codes({ network_mode: "host" }, {}, { ...GOLDEN_STAGE, network: "bridge" })).toEqual(["host_network"]);
  });

  it("reports several deviations in contract order, each once", () => {
    expect(codes({ privileged: true, cap_add: ["SYS_ADMIN"], network_mode: "host" })).toEqual(["privileged", "cap_added", "host_network"]);
  });

  it("flags the docker socket as a mount", () => {
    const mounts = [...mountsExcept("/never"), bind("/var/run/docker.sock", "/var/run/docker.sock")];
    expect(codes({ mounts })).toEqual(["docker_socket_mounted", "unexpected_mount", "forbidden_mount_source"]);
  });

  it("flags an extra mount and a writable scenario mount", () => {
    expect(codes({ mounts: [...goldenObserved().facts.mounts, bind("/srv/cache", "/cache")] })).toEqual(["unexpected_mount"]);
    expect(codes({ mounts: [...mountsExcept("/scenarios"), bind(SCENARIOS, "/scenarios", false)] })).toEqual(["mount_not_read_only"]);
  });

  it("flags a source that differs from the pinned one, even at an allowed destination", () => {
    const other = `${OMF_HOME}/projects/p-1/worktrees/w-ffffffffffff`;
    expect(codes({ mounts: [...mountsExcept("/work"), bind(other, "/work")] })).toContain("unexpected_mount");
    expect(codes({ mounts: [...mountsExcept("/work"), bind(WORKTREE, "/elsewhere")] })).toContain("unexpected_mount");
  });

  it("flags an ANCESTOR of a forbidden path bound at an allowed destination", () => {
    for (const ancestor of [HOME, `${OMF_HOME}/projects/p-1`, "/"]) {
      expect(codes({ mounts: [...mountsExcept("/work"), bind(ancestor, "/work")] })).toEqual(["unexpected_mount", "forbidden_mount_source"]);
    }
  });

  it("flags a source equal to or under a forbidden path", () => {
    for (const source of [`${HOME}/repo`, `${HOME}/repo/.git`, `${HOME}/.claude/projects`]) {
      expect(codes({ mounts: [...mountsExcept("/work"), bind(source, "/work")] })).toEqual(["unexpected_mount", "forbidden_mount_source"]);
    }
  });

  it("does not treat a sibling that shares a name prefix as forbidden", () => {
    const golden = { ...GOLDEN_STAGE, forbidden_paths: ["/srv/a/b"] };
    expect(codes({ mounts: [...goldenObserved().facts.mounts, bind("/srv/a/bc", "/x")] }, {}, golden)).toEqual(["unexpected_mount"]);
    expect(codes({ mounts: [...goldenObserved().facts.mounts, bind("/srv/a/b/c", "/x")] }, {}, golden)).toEqual(["unexpected_mount", "forbidden_mount_source"]);
  });

  it("compares case-insensitively on macOS only", () => {
    const spelled = `${HOME.toUpperCase()}`;
    const expected: ViolationCode[] = process.platform === "darwin" ? ["unexpected_mount", "forbidden_mount_source"] : ["unexpected_mount"];
    expect(codes({ mounts: [...mountsExcept("/work"), bind(spelled, "/work")] })).toEqual(expected);
  });
});

describe("pathRelation", () => {
  it.each([
    ["/a/b", "/a/b", "equal"],
    ["/a/b/", "/a//b", "equal"],
    ["/a/b/c", "/a/b", "under"],
    ["/a", "/a/b", "ancestor"],
    ["/", "/a/b", "ancestor"],
    ["/a/bc", "/a/b", "disjoint"],
    ["/a/b", "/a/bc", "disjoint"],
    ["/a/x/../b", "/a/b", "equal"],
  ] as const)("%s against %s is %s", (path, other, relation) => {
    expect(pathRelation(path, other, false)).toBe(relation);
  });

  it("folds case only when asked", () => {
    expect(pathRelation("/Users/Dev/Repo", "/users/dev/repo", true)).toBe("equal");
    expect(pathRelation("/Users/Dev/Repo", "/users/dev/repo", false)).toBe("disjoint");
  });
});

describe("hostStage", () => {
  it("is L1 with no_container and no facts", () => {
    const measurement = hostStage("sut", AT);
    expect(measurement).toEqual({
      stage: "sut",
      mode: "host",
      measured_at: AT.toISOString(),
      facts: null,
      checks: null,
      level: "L1",
      violations: ["no_container"],
      facts_sha256: sha256Hex(canonicalize({ stage: "sut", mode: "host", facts: null, checks: null })),
    });
    expect(hostStage("harness", AT).facts_sha256).not.toBe(measurement.facts_sha256);
  });

  it("can never lift a run: three L2 stages and a host stage stay L1", () => {
    const all = [
      ...(["author", "implementer", "harness"] as const).map((stage) => measurement(stage, "L2")),
      hostStage("sut", AT),
    ];
    expect(runIsolation(RUN, all)).toMatchObject({ level: "L1", complete: true });
  });
});
