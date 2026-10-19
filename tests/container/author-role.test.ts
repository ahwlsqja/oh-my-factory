import { describe, expect, it } from "vitest";
import { goldenFor } from "../../src/container/golden.js";
import { createMeasured } from "../../src/container/measure.js";
import type { ImageInfo } from "../../src/container/runtime.js";
import {
  AUTHOR_ENV_NAMES,
  ContainerSpecError,
  type ImageId,
  ROLE_STAGE,
  type RoleLimits,
  assertName,
  roleTmpfs,
} from "../../src/container/spec.js";
import { CONFIG_DEFAULTS } from "../../src/core/config.js";
import type { StageMeasurement } from "../../src/isolation/types.js";
import { FIXTURE_RUN_ID, limitsFor, specFor } from "../helpers/container-fixture.js";
import { type MeasureFixture, type Tamper, measureFixture } from "../helpers/measure-fixture.js";

// covers: S5.3.author-container-argv
// The author is the fifth container role: a name, a stage, four tmpfs mounts, a network, one vendor CLI and a golden of its
// own. The argv bytes are pinned in W-author-argv-golden; the absence of any host path in W-seal-no-forbidden-mounts.
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof ContainerSpecError ? error.code : `other: ${String(error)}`;
  }
  return "no error";
};

const IMAGE: ImageInfo = {
  id: `sha256:${"d".repeat(64)}` as ImageId,
  env_names: ["PATH", "NODE_VERSION", "CODEX_API_KEY", "OPENAI_API_KEY"],
  user: "",
  volumes: [],
};
const CODEX_PROBE = "vendor:codex\nsocket:0\nend\n";

describe("the author role", () => {
  it("has a name of its own, the author stage and four owned scratch filesystems, none executable", () => {
    const spec = specFor("author");
    expect(spec.name).toBe(`omf-author-${FIXTURE_RUN_ID}-1-1`);
    expect(() => assertName(spec.name, spec.labels)).not.toThrow();
    expect(ROLE_STAGE.author).toBe("author");
    expect(spec.tmpfs.map((mount) => [mount.destination, mount.size_mb, mount.exec, mount.owned])).toEqual([
      ["/tmp", 64, false, true],
      ["/in", 16, false, true],
      ["/out", 16, false, true],
      ["/agent", 128, false, true],
    ]);
    expect(spec.limits).toEqual({ memory_mb: 1024, cpus: 1, pids: 256 });
  });

  it("refuses limits of another kind, and refuses author limits for another role", () => {
    const judge: RoleLimits = { kind: "judge", judge: CONFIG_DEFAULTS.judge };
    expect(codeOf(() => roleTmpfs("author", judge))).toBe("invalid_limits");
    expect(codeOf(() => roleTmpfs("sut", limitsFor("author")))).toBe("invalid_limits");
    expect(codeOf(() => roleTmpfs("implementer", limitsFor("author")))).toBe("invalid_limits");
  });
});

describe("the author golden", () => {
  it("pins the network, the four tmpfs mounts, the one vendor CLI and no credential path", () => {
    const golden = goldenFor({ role: "author", image: IMAGE, forbidden: ["/home/dev"] });
    expect(golden).toMatchObject({
      network: "bridge",
      require_read_only_rootfs: true,
      allowed_vendor_binaries: ["codex"],
      allowed_credential_paths: [],
      forbidden_paths: ["/home/dev"],
    });
    expect(golden.allowed_mounts.map((mount) => mount.destination).sort()).toEqual(["/agent", "/in", "/out", "/tmp"]);
    expect(golden.allowed_mounts.every((mount) => mount.source === "" && !mount.read_only)).toBe(true);
  });

  it("allows the image's names without any credential name, plus the daemon's and the fixed author names", () => {
    expect([...AUTHOR_ENV_NAMES]).toEqual(["CODEX_HOME", "HOME", "NO_COLOR", "OMF_TMP"]);
    const names = goldenFor({ role: "author", image: IMAGE, forbidden: [] }).allowed_env_names;
    expect(names).toEqual(["CODEX_HOME", "HOME", "HOSTNAME", "LC_ALL", "NODE_VERSION", "NO_COLOR", "OMF_TMP", "PATH"]);
    expect(names).not.toContain("CODEX_API_KEY");
    expect(names).not.toContain("OPENAI_API_KEY");
  });
});

function deferredTo(f: MeasureFixture, handed: StageMeasurement[]) {
  return {
    runtime: f.deps.runtime,
    now: f.deps.now,
    defer: (measurement: StageMeasurement): void => void handed.push(measurement),
  };
}

describe("measuring an author container", () => {
  it("refuses to record an author measurement that no seal binds, and removes the container", async () => {
    const f = await measureFixture({ probe: CODEX_PROBE });
    await expect(createMeasured(f.deps, f.spec("author"), f.golden("author"))).rejects.toThrow(
      "the author stage needs author_scope",
    );
    expect(f.lifecycle()).toEqual(["create", "inspect", "start", "exec", "rm"]);
    expect(f.isolationEvents()).toEqual([]);
  });

  it("measures a golden container L2 under the author stage, on a bridge, with tmpfs mounts only", async () => {
    const f = await measureFixture({ probe: CODEX_PROBE });
    const handed: StageMeasurement[] = [];
    const { measurement } = await createMeasured(deferredTo(f, handed), f.spec("author"), f.golden("author"));
    expect(handed).toEqual([measurement]);
    expect(measurement).toMatchObject({ stage: "author", mode: "container", level: "L2", violations: [] });
    expect(measurement.facts?.network_mode).toBe("bridge");
    expect(measurement.facts?.mounts.map((mount) => mount.destination).sort()).toEqual([
      "/agent",
      "/in",
      "/out",
      "/tmp",
    ]);
    expect(f.lifecycle()).toEqual(["create", "inspect", "start", "exec"]);
    expect(f.isolationEvents()).toEqual([]);
  });

  interface Case {
    name: string;
    options: { imageEnv?: string[] };
    tamper: Tamper;
    codes: string[];
    lifecycle: string[];
  }
  const baked = (variable: string): Case["options"] => ({
    imageEnv: ["PATH=/usr/bin", `${variable}=not-a-real-value`],
  });
  const PRE_GATE = ["create", "inspect", "rm"];
  const AFTER_PROBE = ["create", "inspect", "start", "exec", "rm"];
  const CASES: Case[] = [
    {
      name: "an image that bakes in CODEX_API_KEY",
      options: baked("CODEX_API_KEY"),
      tamper: {},
      codes: ["unexpected_env_name"],
      lifecycle: PRE_GATE,
    },
    {
      name: "an image that bakes in ANTHROPIC_API_KEY",
      options: baked("ANTHROPIC_API_KEY"),
      tamper: {},
      codes: ["unexpected_env_name"],
      lifecycle: PRE_GATE,
    },
    {
      name: "an image that bakes in OPENAI_API_KEY",
      options: baked("OPENAI_API_KEY"),
      tamper: {},
      codes: ["unexpected_env_name"],
      lifecycle: PRE_GATE,
    },
    {
      name: "a claude binary",
      options: {},
      tamper: { probe: "vendor:claude\nsocket:0\nend\n" },
      codes: ["vendor_binary_present"],
      lifecycle: AFTER_PROBE,
    },
    {
      name: "a ~/.codex login",
      options: {},
      tamper: { probe: "cred:.codex\nsocket:0\nend\n" },
      codes: ["credential_present"],
      lifecycle: AFTER_PROBE,
    },
    {
      name: "a docker socket",
      options: {},
      tamper: { probe: "socket:1\nend\n" },
      codes: ["docker_socket_present"],
      lifecycle: AFTER_PROBE,
    },
  ];

  it.each(CASES)(
    "$name is L1 with $codes, the container is removed and nothing is handed over",
    async ({ options, tamper, codes, lifecycle }) => {
      const f = await measureFixture(tamper, options);
      const handed: StageMeasurement[] = [];
      await expect(createMeasured(deferredTo(f, handed), f.spec("author"), f.golden("author"))).rejects.toMatchObject({
        violations: codes,
      });
      expect(f.lifecycle()).toEqual(lifecycle);
      expect(handed).toEqual([]);
      expect(f.isolationEvents()).toEqual([]);
    },
  );
});
