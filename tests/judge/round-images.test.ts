import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ImageRefError, pinnedImage } from "../../src/container/image-ref.js";
import type { ContainerRuntime, ImageInfo } from "../../src/container/runtime.js";
import type { ImageId, OwnedLabels } from "../../src/container/spec.js";
import { sutImageTag } from "../../src/container/sut-build.js";
import type { JudgeConfig } from "../../src/core/config.js";
import { harnessContextSha256, harnessSources, harnessTag } from "../../src/judge/harness-context.js";
import { buildRoundImages, disposeImages } from "../../src/judge/round.js";
import { gitFixture } from "../helpers/git-fixture.js";
import { judgeConfig } from "../helpers/judge-fixture.js";
import { makeTempDir } from "../helpers/tmp.js";

const SUT_BASE = `registry.example/sut-base@sha256:${"b".repeat(64)}`;
const HARNESS_BASE = `registry.example/node@sha256:${"c".repeat(64)}`;
const LABELS: OwnedLabels = { work_id: "w-0123456789ab", run_id: "r-20261015T000000Z-0a1b", round: 2, role: "sut" };
const CONTRACT = { build: ["true"], run: ["sh", "/work/app.sh"] };
const info = (n: number): ImageInfo => ({
  id: `sha256:${String(n).repeat(64)}` as ImageId,
  env_names: [],
  user: "65532:65532",
  volumes: [],
});

/** A daemon that knows only the images built through it. */
function registry() {
  const present = new Map<string, ImageInfo>();
  const builds: { tag: string; role: string; files: string[] }[] = [];
  const removed: ImageId[] = [];
  /** Every reviewed pull and every build, in call order. */
  const steps: string[] = [];
  /** Base images the daemon can fetch; any other absent base makes `ensureImage` fail. */
  const pullable = new Set<string>([SUT_BASE, HARNESS_BASE]);
  const runtime: Pick<ContainerRuntime, "build" | "imageInfo" | "removeImage" | "ensureImage"> = {
    ensureImage: async (ref) => {
      steps.push(`ensure ${ref}`);
      if (!pullable.has(ref)) throw new Error("manifest unknown");
      return info(9);
    },
    imageInfo: async (ref) => {
      const image = present.get(ref);
      if (image === undefined) throw new Error("no such image");
      return image;
    },
    build: async (spec) => {
      steps.push(`build ${spec.labels.role}`);
      builds.push({ tag: spec.tag, role: spec.labels.role, files: readdirSync(spec.contextDir).sort() });
      const image = info(builds.length);
      present.set(spec.tag, image);
      return image;
    },
    removeImage: async (id) => {
      removed.push(id);
    },
  };
  return { runtime, builds, removed, steps, pullable };
}

function input(
  runtime: Pick<ContainerRuntime, "build" | "imageInfo" | "ensureImage">,
  config: JudgeConfig,
  contextRoot: string,
) {
  const fx = gitFixture({ "app.sh": 'echo bye "$1"\n' }, { "app.sh": 'echo hello "$1"\n' });
  return {
    runtime,
    config,
    contract: CONTRACT,
    candidate: { quarantine: fx.quarantine, sha: fx.head },
    labels: LABELS,
    contextRoot,
  };
}

describe("buildRoundImages", () => {
  it("builds the harness image, then the SUT image from the candidate commit, and the lease disposes only the SUT image", async () => {
    const { runtime, builds, removed } = registry();
    const contextRoot = join(makeTempDir("omf-round-images-"), "ctx");
    const config = judgeConfig({ sut_base_image: SUT_BASE, harness_base_image: HARNESS_BASE });
    const lease = await buildRoundImages(input(runtime, config, contextRoot));
    const hash = harnessContextSha256(harnessSources(), pinnedImage(HARNESS_BASE));
    expect(builds).toEqual([
      { tag: harnessTag(hash), role: "harness", files: ["Dockerfile", "main.mjs", "matcher.mjs"] },
      { tag: sutImageTag(LABELS), role: "sut", files: ["Dockerfile", "candidate.tar"] },
    ]);
    expect(lease).toEqual({
      sut: info(2),
      harness: info(1),
      harness_context_sha256: hash,
      sut_base: SUT_BASE,
      harness_base: HARNESS_BASE,
      labels: LABELS,
    });
    expect(readdirSync(contextRoot)).toEqual([]);
    const next = await buildRoundImages({ ...input(runtime, config, contextRoot), labels: { ...LABELS, round: 3 } });
    expect(builds.map((b) => b.role)).toEqual(["harness", "sut", "sut"]); // the harness image is reused by its context hash
    expect(next.harness).toEqual(info(1));
    await disposeImages(runtime, lease);
    expect(removed).toEqual([info(2).id]);
  });

  it("refuses an unset or tagged base image before building anything", async () => {
    for (const over of [{ sut_base_image: null }, { harness_base_image: "node:22-alpine" }] as Partial<JudgeConfig>[]) {
      const { runtime, builds } = registry();
      const config = judgeConfig({ sut_base_image: SUT_BASE, harness_base_image: HARNESS_BASE, ...over });
      await expect(
        buildRoundImages(input(runtime, config, join(makeTempDir("omf-round-images-"), "ctx"))),
      ).rejects.toBeInstanceOf(ImageRefError);
      expect(builds).toEqual([]);
    }
  });

  it("pulls both digest-pinned bases through the reviewed path before any build", async () => {
    const { runtime, steps } = registry();
    const config = judgeConfig({ sut_base_image: SUT_BASE, harness_base_image: HARNESS_BASE });
    await buildRoundImages(input(runtime, config, join(makeTempDir("omf-round-images-"), "ctx")));
    expect(steps).toEqual([`ensure ${HARNESS_BASE}`, `ensure ${SUT_BASE}`, "build harness", "build sut"]);
  });

  it.each([
    ["harness", { harness_base_image: HARNESS_BASE.replace("c", "e") }],
    ["SUT", { sut_base_image: SUT_BASE.replace("b", "e") }],
  ])("fails closed and builds nothing when the %s base is absent and cannot be fetched", async (_role, over) => {
    const { runtime, builds } = registry();
    const config = judgeConfig({ sut_base_image: SUT_BASE, harness_base_image: HARNESS_BASE, ...over });
    await expect(
      buildRoundImages(input(runtime, config, join(makeTempDir("omf-round-images-"), "ctx"))),
    ).rejects.toThrow("manifest unknown");
    expect(builds).toEqual([]);
  });
});
