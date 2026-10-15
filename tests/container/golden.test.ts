import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { forbiddenPaths, goldenFor } from "../../src/container/golden.js";
import type { ImageInfo } from "../../src/container/runtime.js";
import type { ImageId } from "../../src/container/spec.js";
import { locateProject } from "../../src/core/paths.js";
import { makeGitRepo, makeTempDir } from "../helpers/tmp.js";

const IMAGE: ImageInfo = {
  id: `sha256:${"b".repeat(64)}` as ImageId,
  env_names: ["NODE_VERSION", "PATH"],
  user: "",
  volumes: [],
};

describe("goldenFor", () => {
  it.each([
    ["sut", ["/scratch", "/tmp"]],
    ["harness", ["/state", "/tmp"]],
    ["workcopy", ["/tmp", "/work"]],
  ] as const)(
    "pins %s: no network, read-only root, only its own tmpfs mounts, no vendor CLI or credential",
    (role, mounts) => {
      const golden = goldenFor({ role, image: IMAGE, forbidden: ["/home/dev"] });
      expect(golden).toMatchObject({
        network: "none",
        require_read_only_rootfs: true,
        allowed_vendor_binaries: [],
        allowed_credential_paths: [],
        forbidden_paths: ["/home/dev"],
      });
      expect(golden.allowed_mounts.map((mount) => mount.destination).sort()).toEqual([...mounts]);
      expect(golden.allowed_mounts.every((mount) => mount.source === "" && !mount.read_only)).toBe(true);
    },
  );

  it("allows the image's own environment names plus the daemon's, and nothing else", () => {
    expect(goldenFor({ role: "sut", image: IMAGE, forbidden: [] }).allowed_env_names).toEqual([
      "HOME",
      "HOSTNAME",
      "LC_ALL",
      "NODE_VERSION",
      "PATH",
    ]);
  });
});

describe("forbiddenPaths", () => {
  it("holds the vault, state, repository, home and agent config homes as real paths, once each", () => {
    const real = makeTempDir("omf-real-home-");
    const link = join(makeTempDir("omf-link-"), "home");
    symlinkSync(real, link);
    const repo = makeGitRepo();
    const env = { HOME: link, OMF_HOME: join(real, ".omf") };
    const location = locateProject(repo, env);
    mkdirSync(location.dir, { recursive: true, mode: 0o700 });
    const paths = forbiddenPaths(location, env);
    const realHome = realpathSync.native(real);
    for (const expected of [
      realHome,
      realpathSync.native(repo),
      join(realHome, ".claude"),
      join(realHome, ".codex"),
      join(realHome, ".config"),
      join(realpathSync.native(location.dir), "vault"),
    ]) {
      expect(paths).toContain(expected);
    }
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.some((path) => path.startsWith(link))).toBe(false);
  });
});
