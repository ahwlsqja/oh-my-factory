import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pinnedImage } from "../../src/container/image-ref.js";
import { harnessContextSha256, harnessSources, writeHarnessContext } from "../../src/judge/harness-context.js";
import { makeTempDir } from "../helpers/tmp.js";

const BASE = pinnedImage(`registry.example/node@sha256:${"c".repeat(64)}`);

describe("harness context file modes", () => {
  it("writes files the sandbox user can read once they are copied into the image", () => {
    const sources = harnessSources();
    const dir = makeTempDir("omf-harness-mode-");
    writeHarnessContext(dir, sources, BASE, harnessContextSha256(sources, BASE));
    const names = readdirSync(dir).sort();
    expect(names).toEqual(["Dockerfile", "main.mjs", "matcher.mjs"]);
    for (const name of names) expect(statSync(join(dir, name)).mode & 0o444).toBe(0o444);
  });
});
