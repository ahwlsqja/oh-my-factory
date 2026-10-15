import { execFileSync } from "node:child_process";
import { createDockerRuntime } from "../../src/container/docker-cli.js";
import { type PinnedImage, pinnedImage } from "../../src/container/image-ref.js";
import type { ContainerRuntime } from "../../src/container/runtime.js";
import type { OwnedLabels } from "../../src/container/spec.js";
import { buildSutImage } from "../../src/container/sut-build.js";
import { CONFIG_DEFAULTS, type JudgeConfig } from "../../src/core/config.js";
import type { GitTarget } from "../../src/git/hardened.js";
import { ensureHarnessImage } from "../../src/judge/harness-context.js";
import type { ImageLease } from "../../src/judge/round.js";
import { type GatedContext, gatedPath } from "./helpers.js";

export const GATED_LABELS = { work_id: "w-0123456789ab", run_id: "r-20261015T090000Z-ab12", round: 1 };
export const GATED_SCOPE = { goal_id: "g-gated", work_id: GATED_LABELS.work_id, run_id: GATED_LABELS.run_id };

/** A digest-pinned reference from the environment; a missing one is a refusal, never a tag pulled in its place. */
function requiredDigest(name: string, purpose: string): PinnedImage {
  const ref = process.env[name];
  if (ref === undefined || ref === "") {
    throw new Error(`${name} must name ${purpose} by digest (registry/name@sha256:...); no image is pulled by tag`);
  }
  return pinnedImage(ref);
}

/** A digest-pinned base image with `sh`, `sleep` and `tar` (busybox), named by `OMF_GATED_BASE_IMAGE`. */
export function gatedBaseImage(_ctx: GatedContext): PinnedImage {
  return requiredDigest("OMF_GATED_BASE_IMAGE", "a base image with sh, sleep and tar");
}

/** The harness runs `node main.mjs`, so its base also ships Node: `OMF_GATED_HARNESS_IMAGE`. */
export function gatedHarnessImage(_ctx: GatedContext): PinnedImage {
  return requiredDigest("OMF_GATED_HARNESS_IMAGE", "a base image with Node");
}

export function gatedRuntime(ctx: GatedContext): ContainerRuntime {
  return createDockerRuntime({ context: ctx.context, dockerConfig: ctx.dockerConfig, env: { PATH: gatedPath() } });
}

export function gatedJudgeConfig(ctx: GatedContext, base: PinnedImage, harnessBase: PinnedImage = base): JudgeConfig {
  return {
    ...CONFIG_DEFAULTS.judge,
    sut_base_image: base,
    harness_base_image: harnessBase,
    docker_context: ctx.context,
  };
}

function docker(ctx: GatedContext, args: readonly string[]): string[] {
  const out = execFileSync("docker", ["--context", ctx.context, ...args], {
    encoding: "utf8",
    env: { PATH: gatedPath(), DOCKER_CONFIG: ctx.dockerConfig },
  });
  return out.split("\n").filter((line) => line !== "");
}

/**
 * Everything OMF-labelled that is still in the daemon, as one list. The cached harness image (`omf-harness:...`) is the one
 * explicit exemption; any other container, network, volume or image is a leak.
 */
export function ownedLeftovers(ctx: GatedContext): string[] {
  const label = ["--filter", "label=omf.owner=omf"];
  return [
    ...docker(ctx, ["ps", "-a", "--format", "container {{.Names}}", ...label]),
    ...docker(ctx, ["network", "ls", "--format", "network {{.Name}}", ...label]),
    ...docker(ctx, ["volume", "ls", "--format", "volume {{.Name}}", ...label]),
    ...docker(ctx, ["images", "--format", "image {{.Repository}}:{{.Tag}}", ...label]).filter(
      (line) => !line.startsWith("image omf-harness:"),
    ),
  ];
}

const BUILD_TIMEOUT_MS = 600_000;

/**
 * Builds the two images one round runs on, the way the S4 station will: the cached harness image (keyed by its context hash)
 * and a per-round SUT image from the quarantine commit. The SUT uses the gated base image and the harness a Node image.
 */
export async function buildRoundImages(input: {
  runtime: ContainerRuntime;
  base: PinnedImage;
  harnessBase: PinnedImage;
  build: readonly string[];
  quarantine: GitTarget;
  sha: string;
  labels: OwnedLabels;
  contextRoot: string;
}): Promise<ImageLease> {
  const harness = await ensureHarnessImage({
    runtime: input.runtime,
    base: input.harnessBase,
    labels: input.labels,
    contextRoot: input.contextRoot,
    timeoutMs: BUILD_TIMEOUT_MS,
  });
  const sut = await buildSutImage({
    runtime: input.runtime,
    quarantine: input.quarantine,
    sha: input.sha,
    base: input.base,
    build: input.build,
    labels: input.labels,
    contextRoot: input.contextRoot,
    timeoutMs: BUILD_TIMEOUT_MS,
  });
  return {
    sut,
    harness: harness.image,
    harness_context_sha256: harness.context_sha256,
    sut_base: input.base,
    harness_base: input.harnessBase,
    labels: input.labels,
  };
}
