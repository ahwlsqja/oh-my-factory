import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PinnedImage } from "../container/image-ref.js";
import type { ContainerRuntime, ImageInfo } from "../container/runtime.js";
import type { OwnedLabels } from "../container/spec.js";

/** The three files of the harness image context: the recipe, the program and OMF's own compiled matcher. */
export interface HarnessSources {
  dockerfile: Buffer;
  main: Buffer;
  matcher: Buffer;
}

export class HarnessContextError extends Error {
  readonly code = "source_missing";

  constructor() {
    super("source_missing");
    this.name = "HarnessContextError";
  }
}

function read(file: string): Buffer {
  try {
    return readFileSync(file);
  } catch {
    throw new HarnessContextError();
  }
}

/**
 * Reads the shipped files: `<package>/harness/{Dockerfile,main.mjs}` and `<package>/dist/scenario/matcher.js`. Both
 * URLs sit two levels above `src/judge` and `dist/judge`, like `schemaUrl`. `matcher.js` imports only types, so the
 * compiled file is self-contained and the harness runs the very matcher the host tests cover (M3f-D6).
 */
export function harnessSources(options: { harnessDir?: string; matcherFile?: string } = {}): HarnessSources {
  const dir = options.harnessDir ?? fileURLToPath(new URL("../../harness/", import.meta.url));
  const matcher = options.matcherFile ?? fileURLToPath(new URL("../../dist/scenario/matcher.js", import.meta.url));
  return {
    dockerfile: read(join(dir, "Dockerfile")),
    main: read(join(dir, "main.mjs")),
    matcher: read(matcher),
  };
}

/**
 * SHA-256 over the base reference and every file of the context, each framed by its name and length so no two inputs
 * share a byte stream. It is the second half of judge config (M3e-D23): the harness a verdict came from is named by it.
 */
export function harnessContextSha256(sources: HarnessSources, base: PinnedImage): string {
  const hash = createHash("sha256");
  const part = (name: string, data: Uint8Array): void => {
    hash.update(`${name}:${data.length}\n`, "utf8");
    hash.update(data);
    hash.update("\n", "utf8");
  };
  part("base", Buffer.from(base, "utf8"));
  part("Dockerfile", sources.dockerfile);
  part("main.mjs", sources.main);
  part("matcher.mjs", sources.matcher);
  return hash.digest("hex");
}

/** `FROM` the pinned base, the recipe, then the context label. The label is not an input of the hash. */
export function renderHarnessDockerfile(sources: HarnessSources, base: PinnedImage, contextSha256: string): string {
  return `FROM ${base}\n${sources.dockerfile.toString("utf8")}LABEL omf.context=${contextSha256}\n`;
}

/**
 * Writes the rendered Dockerfile, `main.mjs` and `matcher.mjs` (the matcher is `.mjs` so Node reads it as a module
 * without a package.json) into an existing directory. Files are created exclusively, so a stale context is refused.
 */
export function writeHarnessContext(
  dir: string,
  sources: HarnessSources,
  base: PinnedImage,
  contextSha256: string,
): void {
  // The files end up in the image as written, and the harness runs as the sandbox user: a 0600 file would belong to root and be
  // unreadable there. The context directory is 0700, so 0644 files are still private on the host.
  const write = (name: string, data: string | Buffer): void => {
    const file = join(dir, name);
    writeFileSync(file, data, { mode: 0o644, flag: "wx" });
    chmodSync(file, 0o644);
  };
  write("Dockerfile", renderHarnessDockerfile(sources, base, contextSha256));
  write("main.mjs", sources.main);
  write("matcher.mjs", sources.matcher);
}

/**
 * The cache key is the full hash. `ImageInfo` carries no labels, so reuse is keyed by the tag: a prefix could let two
 * different contexts share an image, the full hash cannot.
 */
export function harnessTag(contextSha256: string): string {
  return `omf-harness:${contextSha256}`;
}

/**
 * Returns the cached harness image when the tag named by the full context hash exists, else builds it from a private
 * 0700 context directory that is removed afterwards. A cached image is trusted as far as the local daemon is: the
 * harness holds scenarios but runs no candidate code, and every harness container is measured before it starts.
 */
export async function ensureHarnessImage(input: {
  runtime: Pick<ContainerRuntime, "build" | "imageInfo">;
  base: PinnedImage;
  labels: OwnedLabels;
  contextRoot: string;
  timeoutMs: number;
  sources?: HarnessSources;
}): Promise<{ image: ImageInfo; context_sha256: string; reused: boolean }> {
  const sources = input.sources ?? harnessSources();
  const contextSha256 = harnessContextSha256(sources, input.base);
  const tag = harnessTag(contextSha256);
  const cached = await input.runtime.imageInfo(tag).catch(() => null);
  if (cached !== null) return { image: cached, context_sha256: contextSha256, reused: true };
  const contextDir = join(input.contextRoot, "ctx-harness");
  mkdirSync(input.contextRoot, { recursive: true, mode: 0o700 });
  mkdirSync(contextDir, { mode: 0o700 });
  try {
    writeHarnessContext(contextDir, sources, input.base, contextSha256);
    const image = await input.runtime.build({ contextDir, tag, labels: input.labels, timeoutMs: input.timeoutMs });
    return { image, context_sha256: contextSha256, reused: false };
  } finally {
    rmSync(contextDir, { recursive: true, force: true });
  }
}
