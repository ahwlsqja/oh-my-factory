import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GitTarget } from "../git/hardened.js";
import { archiveTar } from "../git/ops.js";
import type { PinnedImage } from "./image-ref.js";
import type { ContainerRuntime, ImageInfo } from "./runtime.js";
import { type OwnedLabels, SANDBOX_USER } from "./spec.js";

/** The round's SUT image tag. `run_id` and `round` come from OMF, and the tag only has characters Docker accepts. */
export function sutImageTag(labels: Pick<OwnedLabels, "run_id" | "round">): string {
  return `omf-sut:${labels.run_id}-${labels.round}`;
}

/**
 * Closed template (M3-D2b): five fixed lines, or four when the contract declares no build. The build argv is the only
 * data in it and enters as a JSON array in exec form, so no shell ever reads it and quotes, newlines, `$()` and
 * backticks are plain array elements. The base is a `PinnedImage`: no whitespace, so it cannot add a line.
 */
export function renderSutDockerfile(input: { base: PinnedImage; build: readonly string[] }): string {
  const lines = [`FROM ${input.base}`, "ADD candidate.tar /work/", "WORKDIR /work"];
  if (input.build.length > 0) lines.push(`RUN ${JSON.stringify(input.build)}`);
  lines.push(`USER ${SANDBOX_USER}`);
  return `${lines.join("\n")}\n`;
}

/**
 * `git archive` of `sha` from the quarantine (the hardened `archiveTar`, git objects only) into a private 0700 context
 * directory beside a Dockerfile, then `docker build` with no network, no pull and no cache (`buildArgv`). A directory a
 * container wrote is never read, and the archive is never extracted on the host. `<contextRoot>/ctx-sut` must not
 * exist: a stale context is refused, not reused and not wiped. The context is removed in `finally`.
 *
 * The build step itself runs the candidate's declared build as root inside BuildKit and is not measured (M3f-D23).
 */
export async function buildSutImage(input: {
  runtime: Pick<ContainerRuntime, "build">;
  quarantine: GitTarget;
  sha: string;
  base: PinnedImage;
  build: readonly string[];
  labels: OwnedLabels;
  contextRoot: string;
  timeoutMs: number;
}): Promise<ImageInfo> {
  mkdirSync(input.contextRoot, { recursive: true, mode: 0o700 });
  const contextDir = join(input.contextRoot, "ctx-sut");
  mkdirSync(contextDir, { mode: 0o700 });
  try {
    await archiveTar(input.quarantine, input.sha, join(contextDir, "candidate.tar"));
    writeFileSync(join(contextDir, "Dockerfile"), renderSutDockerfile({ base: input.base, build: input.build }), {
      mode: 0o600,
      flag: "wx",
    });
    return await input.runtime.build({
      contextDir,
      tag: sutImageTag(input.labels),
      labels: input.labels,
      timeoutMs: input.timeoutMs,
    });
  } finally {
    rmSync(contextDir, { recursive: true, force: true });
  }
}
