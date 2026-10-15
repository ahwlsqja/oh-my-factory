import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { pinnedImage } from "../../src/container/image-ref.js";
import type { ContainerRuntime, ImageInfo } from "../../src/container/runtime.js";
import type { ImageId, OwnedLabels } from "../../src/container/spec.js";
import { buildSutImage } from "../../src/container/sut-build.js";
import { gitEnv } from "../../src/core/paths.js";
import { makeOpsFixture, realTempDir } from "../helpers/ops-fixture.js";

const BASE = pinnedImage(`registry.example/base/node@sha256:${"a".repeat(64)}`);
const LABELS: OwnedLabels = { work_id: "w-0123456789ab", run_id: "r-20261015T010203Z-ab12", round: 1, role: "sut" };
const INFO: ImageInfo = {
  id: `sha256:${"b".repeat(64)}` as ImageId,
  env_names: [],
  user: "65532:65532",
  volumes: [],
};

describe("W-sut-build-from-quarantine-archive", () => {
  it("the build context holds git archive of the candidate sha and nothing a container wrote", async () => {
    const fixture = makeOpsFixture();
    // Decoys: an untracked file in the work repository, and a loose "container-written worktree" with a file and
    // a symlink next to the quarantine. None of them is a commit, so none may appear in the archive.
    writeFileSync(join(fixture.work, "decoy-untracked.txt"), "container-written");
    const loose = join(dirname(fixture.gitDir), "decoy-worktree");
    mkdirSync(loose);
    writeFileSync(join(loose, "decoy-planted.txt"), "container-written");
    symlinkSync("/etc/passwd", join(loose, "decoy-link"));

    let tar = Buffer.alloc(0);
    let listing: string[] = [];
    const runtime: Pick<ContainerRuntime, "build"> = {
      build: async (spec) => {
        listing = readdirSync(spec.contextDir).sort();
        tar = readFileSync(join(spec.contextDir, "candidate.tar"));
        return INFO;
      },
    };
    await buildSutImage({
      runtime,
      quarantine: fixture.quarantine,
      sha: fixture.head,
      base: BASE,
      build: ["make"],
      labels: LABELS,
      contextRoot: realTempDir("omf-sut-root-"),
      timeoutMs: 5000,
    });

    const expected = execFileSync("git", ["--git-dir", fixture.gitDir, "archive", "--format=tar", fixture.head], {
      env: gitEnv(),
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(listing).toEqual(["Dockerfile", "candidate.tar"]);
    expect(tar.length).toBeGreaterThan(0);
    expect(tar.equals(expected)).toBe(true);
    expect(tar.includes("decoy")).toBe(false);
    expect(tar.includes("src/new.ts")).toBe(true); // positive control: committed content is there
  });

  it("the build module takes its bytes from the hardened archive and runs no process of its own", () => {
    const text = readFileSync(new URL("../../src/container/sut-build.ts", import.meta.url), "utf8");
    expect(text).toContain("archiveTar");
    expect(text).not.toMatch(/child_process|process-group/);
  });
});
