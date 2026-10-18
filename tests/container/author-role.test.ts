import { describe, expect, it } from "vitest";
import { goldenFor } from "../../src/container/golden.js";
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
import { FIXTURE_RUN_ID, limitsFor, specFor } from "../helpers/container-fixture.js";

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
