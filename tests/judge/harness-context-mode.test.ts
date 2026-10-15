import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pinnedImage } from "../../src/container/image-ref.js";
import {
  ensureHarnessImage,
  harnessContextSha256,
  harnessSources,
  writeHarnessContext,
} from "../../src/judge/harness-context.js";
import { makeTempDir } from "../helpers/tmp.js";

const BASE = pinnedImage(`registry.example/node@sha256:${"c".repeat(64)}`);

describe("harness context file modes", () => {
  it("keeps the files private on the host and makes the image recipe readable for the sandbox user", () => {
    const sources = harnessSources();
    const dir = makeTempDir("omf-harness-mode-");
    writeHarnessContext(dir, sources, BASE, harnessContextSha256(sources, BASE));
    const names = readdirSync(dir).sort();
    expect(names).toEqual(["Dockerfile", "main.mjs", "matcher.mjs"]);
    for (const name of names) expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    const recipe = sources.dockerfile.toString("utf8");
    expect(recipe).toMatch(/RUN chmod 0?644 \/app\/main\.mjs \/app\/matcher\.mjs/);
    expect(recipe.indexOf("RUN chmod")).toBeLessThan(recipe.indexOf("USER"));
  });

  it("builds from a context directory only the owner can enter", async () => {
    let dirMode = -1;
    const runtime = {
      imageInfo: async () => {
        throw new Error("not cached");
      },
      build: async (spec: { contextDir: string; tag: string }) => {
        dirMode = statSync(spec.contextDir).mode & 0o777;
        return { id: "sha256:abc", tag: spec.tag, labels: {} };
      },
    };
    await ensureHarnessImage({
      runtime: runtime as never,
      base: BASE,
      labels: { work_id: "w-0123456789ab", run_id: "r-x", round: 1 } as never,
      contextRoot: makeTempDir("omf-harness-root-"),
      timeoutMs: 1000,
    });
    expect(dirMode).toBe(0o700);
  });
});
