import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildArgv } from "../../src/container/argv.js";
import { pinnedImage } from "../../src/container/image-ref.js";
import type { ContainerRuntime, ImageInfo } from "../../src/container/runtime.js";
import type { ImageId, OwnedLabels } from "../../src/container/spec.js";
import { buildSutImage, renderSutDockerfile, sutImageTag } from "../../src/container/sut-build.js";
import { makeOpsFixture, realTempDir } from "../helpers/ops-fixture.js";

const BASE = pinnedImage(`registry.example:5000/base/node@sha256:${"a".repeat(64)}`);
const LABELS: OwnedLabels = { work_id: "w-0123456789ab", run_id: "r-20261015T010203Z-ab12", round: 1, role: "sut" };
const INFO: ImageInfo = {
  id: `sha256:${"b".repeat(64)}` as ImageId,
  env_names: [],
  user: "65532:65532",
  volumes: [],
};

describe("renderSutDockerfile", () => {
  it("is exactly the five fixed lines", () => {
    expect(renderSutDockerfile({ base: BASE, build: ["npm", "run", "build"] })).toBe(
      `FROM ${BASE}\nADD candidate.tar /work/\nWORKDIR /work\nRUN ["npm","run","build"]\nUSER 65532:65532\n`,
    );
  });

  it("keeps a hostile build argv inside one JSON array line, in exec form", () => {
    const hostile = ['a"b', "x\ny", "$(touch /tmp/pwn)", "`id`", "; rm -rf /", "-v /:/host", "back\\slash"];
    const lines = renderSutDockerfile({ base: BASE, build: hostile }).split("\n");
    expect(lines).toHaveLength(6);
    expect(lines[3]).toBe(`RUN ${JSON.stringify(hostile)}`);
    expect(JSON.parse((lines[3] ?? "").slice("RUN ".length))).toEqual(hostile);
    for (const index of [0, 1, 2, 4]) for (const element of hostile) expect(lines[index]).not.toContain(element);
  });

  it("leaves out the RUN line when the contract declares no build", () => {
    expect(renderSutDockerfile({ base: BASE, build: [] })).toBe(
      `FROM ${BASE}\nADD candidate.tar /work/\nWORKDIR /work\nUSER 65532:65532\n`,
    );
  });
});

describe("the build argv", () => {
  it("builds with no network, no pull, no cache and the OMF labels", () => {
    const tag = sutImageTag(LABELS);
    expect(tag).toBe("omf-sut:r-20261015T010203Z-ab12-1");
    const argv = buildArgv({ contextDir: "/ctx", tag, labels: LABELS }, "colima-omf-m3f");
    const has = (...sequence: string[]): boolean =>
      argv.some((_, index) => sequence.every((element, offset) => argv[index + offset] === element));
    expect(argv.slice(0, 2)).toEqual(["--context", "colima-omf-m3f"]);
    expect(argv).toContain("build");
    expect(has("--network", "none")).toBe(true);
    expect(argv).toContain("--pull=false");
    expect(argv).toContain("--no-cache");
    expect(has("--label", "omf.owner=omf")).toBe(true);
    expect(has("--label", `omf.run=${LABELS.run_id}`)).toBe(true);
    expect(has("--label", `omf.work=${LABELS.work_id}`)).toBe(true);
    expect(argv).toContain(tag);
    expect(argv).toContain("/ctx");
  });
});

describe("buildSutImage", () => {
  const fixture = makeOpsFixture();

  it("builds from a private context holding the Dockerfile and the archive, then removes it", async () => {
    const root = realTempDir("omf-sut-root-");
    const seen: { tag: string; labels: OwnedLabels; timeoutMs: number; files: string[]; dockerfile: string }[] = [];
    const runtime: Pick<ContainerRuntime, "build"> = {
      build: async (spec) => {
        seen.push({
          tag: spec.tag,
          labels: spec.labels,
          timeoutMs: spec.timeoutMs,
          files: readdirSync(spec.contextDir).sort(),
          dockerfile: readFileSync(join(spec.contextDir, "Dockerfile"), "utf8"),
        });
        return INFO;
      },
    };
    const image = await buildSutImage({
      runtime,
      quarantine: fixture.quarantine,
      sha: fixture.head,
      base: BASE,
      build: ["make"],
      labels: LABELS,
      contextRoot: root,
      timeoutMs: 5000,
    });
    expect(image).toBe(INFO);
    expect(seen).toEqual([
      {
        tag: sutImageTag(LABELS),
        labels: LABELS,
        timeoutMs: 5000,
        files: ["Dockerfile", "candidate.tar"],
        dockerfile: renderSutDockerfile({ base: BASE, build: ["make"] }),
      },
    ]);
    expect(existsSync(join(root, "ctx-sut"))).toBe(false);
  });

  it("removes the context when the build fails, and never reuses or wipes a stale one", async () => {
    const failing: Pick<ContainerRuntime, "build"> = {
      build: async () => {
        throw new Error("daemon said no");
      },
    };
    const root = realTempDir("omf-sut-root-");
    const input = {
      runtime: failing,
      quarantine: fixture.quarantine,
      sha: fixture.head,
      base: BASE,
      build: [],
      labels: LABELS,
      contextRoot: root,
      timeoutMs: 5000,
    };
    await expect(buildSutImage(input)).rejects.toThrow("daemon said no");
    expect(existsSync(join(root, "ctx-sut"))).toBe(false);

    mkdirSync(join(root, "ctx-sut"));
    writeFileSync(join(root, "ctx-sut", "stale.txt"), "left by an earlier run");
    await expect(buildSutImage(input)).rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(join(root, "ctx-sut", "stale.txt"), "utf8")).toBe("left by an earlier run");
  });
});
