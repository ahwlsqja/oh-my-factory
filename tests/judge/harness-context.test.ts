import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pinnedImage } from "../../src/container/image-ref.js";
import type { ContainerRuntime, ImageInfo } from "../../src/container/runtime.js";
import type { ImageId, OwnedLabels } from "../../src/container/spec.js";
import {
  type HarnessSources,
  ensureHarnessImage,
  harnessContextSha256,
  harnessSources,
  harnessTag,
  renderHarnessDockerfile,
  writeHarnessContext,
} from "../../src/judge/harness-context.js";
import { makeTempDir } from "../helpers/tmp.js";

const BASE = pinnedImage(`registry.example/node@sha256:${"c".repeat(64)}`);
const LABELS: OwnedLabels = { work_id: "w-0123456789ab", run_id: "r-20261015T010203Z-ab12", round: 1, role: "harness" };
const INFO: ImageInfo = {
  id: `sha256:${"b".repeat(64)}` as ImageId,
  env_names: [],
  user: "65532:65532",
  volumes: [],
};

const flipped = (data: Buffer): Buffer => Buffer.concat([data, Buffer.from(" ")]);

describe("harness sources and the context hash", () => {
  it("reads the recipe, the program and the matcher the package ships", () => {
    const sources = harnessSources();
    expect(sources.main.toString("utf8")).toContain('from "./matcher.mjs"');
    expect(sources.matcher.equals(readFileSync(new URL("../../dist/scenario/matcher.js", import.meta.url)))).toBe(true);
    expect(sources.dockerfile.toString("utf8")).not.toMatch(/^(FROM|LABEL)\b/m);
    expect(sources.dockerfile.toString("utf8")).toContain("USER 65532:65532");
  });

  it("throws source_missing for a missing directory", () => {
    expect(() => harnessSources({ harnessDir: "/nonexistent-omf-harness/" })).toThrow(
      expect.objectContaining({ code: "source_missing" }),
    );
  });

  it("is stable for equal inputs and changes with any byte of any input", () => {
    const sources = harnessSources();
    const hash = harnessContextSha256(sources, BASE);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(harnessContextSha256({ ...sources }, BASE)).toBe(hash);
    const variants: HarnessSources[] = [
      { ...sources, dockerfile: flipped(sources.dockerfile) },
      { ...sources, main: flipped(sources.main) },
      { ...sources, matcher: flipped(sources.matcher) },
    ];
    for (const variant of variants) expect(harnessContextSha256(variant, BASE)).not.toBe(hash);
    const otherBase = pinnedImage(`registry.example/node@sha256:${"d".repeat(64)}`);
    expect(harnessContextSha256(sources, otherBase)).not.toBe(hash);
  });

  it("renders FROM the pinned base, the recipe, and the context label last", () => {
    const sources = harnessSources();
    const hash = harnessContextSha256(sources, BASE);
    const text = renderHarnessDockerfile(sources, BASE, hash);
    expect(text.startsWith(`FROM ${BASE}\n`)).toBe(true);
    expect(text).toContain(sources.dockerfile.toString("utf8"));
    expect(text.endsWith(`LABEL omf.context=${hash}\n`)).toBe(true);
  });

  it("writes exactly the three files the recipe copies", () => {
    const dir = makeTempDir("omf-harness-ctx-");
    const sources = harnessSources();
    writeHarnessContext(dir, sources, BASE, harnessContextSha256(sources, BASE));
    expect(readdirSync(dir).sort()).toEqual(["Dockerfile", "main.mjs", "matcher.mjs"]);
  });

  it("ships in the package", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      files: string[];
    };
    expect(manifest.files).toContain("harness");
    expect(manifest.files).toContain("dist");
  });
});

describe("ensureHarnessImage", () => {
  function registry() {
    const present = new Set<string>();
    const builds: { tag: string; labels: OwnedLabels; files: string[] }[] = [];
    const runtime: Pick<ContainerRuntime, "build" | "imageInfo"> = {
      imageInfo: async (ref) => {
        if (!present.has(ref)) throw new Error("no such image");
        return INFO;
      },
      build: async (spec) => {
        builds.push({ tag: spec.tag, labels: spec.labels, files: readdirSync(spec.contextDir).sort() });
        present.add(spec.tag);
        return INFO;
      },
    };
    return { runtime, builds };
  }

  it("builds once, reuses the image only under the full-hash tag, and rebuilds when any input changes", async () => {
    const { runtime, builds } = registry();
    const contextRoot = makeTempDir("omf-harness-root-");
    const input = { runtime, base: BASE, labels: LABELS, contextRoot, timeoutMs: 1000 };
    const sources = harnessSources();
    const hash = harnessContextSha256(sources, BASE);

    const first = await ensureHarnessImage({ ...input, sources });
    expect(first).toEqual({ image: INFO, context_sha256: hash, reused: false });
    expect(builds).toHaveLength(1);
    expect(builds[0]).toEqual({
      tag: harnessTag(hash),
      labels: LABELS,
      files: ["Dockerfile", "main.mjs", "matcher.mjs"],
    });
    expect(harnessTag(hash)).toBe(`omf-harness:${hash}`);
    expect(existsSync(join(contextRoot, "ctx-harness"))).toBe(false);

    const second = await ensureHarnessImage({ ...input, sources });
    expect(second.reused).toBe(true);
    expect(builds).toHaveLength(1);

    const changed = await ensureHarnessImage({ ...input, sources: { ...sources, main: flipped(sources.main) } });
    expect(changed.reused).toBe(false);
    expect(changed.context_sha256).not.toBe(hash);
    expect(builds).toHaveLength(2);
  });
});
