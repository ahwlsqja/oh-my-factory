import { expect, it } from "vitest";
import { containerFactsFromInspect } from "../../src/isolation/inspect.js";
import { describeGated, gatedDocker, scrubInspect, scrubTargets, writeFixture } from "./helpers.js";

/**
 * Capture-only image. Containers are created and inspected, never started, so none of the image runs.
 * The product path pins images by digest; this one is pulled by tag only if the omf-m3f VM lacks it.
 */
const IMAGE = "alpine:3.20";

const HARDENED = [
  "--network",
  "none",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--read-only",
  "--user",
  "65532:65532",
];
const SHAPES: ReadonlyArray<{ name: string; flags: string[] }> = [
  { name: "minimal", flags: [] },
  { name: "hardened", flags: HARDENED },
  {
    name: "hardened-tmpfs",
    flags: [...HARDENED, "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m", "--tmpfs", "/scratch:rw,noexec,nosuid,size=16m"],
  },
  { name: "bind-ro", flags: [...HARDENED, "-v", "/srv/omf-capture:/mnt:ro"] },
];

function docker(args: string[]): string {
  const result = gatedDocker(args);
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}

describeGated("G-inspect-parser-real", () => {
  it("parses the real inspect output of four container shapes (created, never started)", () => {
    if (gatedDocker(["image", "inspect", IMAGE]).status !== 0) docker(["pull", IMAGE]);
    const names = SHAPES.map((shape) => `omf-capture-${shape.name}-${process.pid}`);
    try {
      SHAPES.forEach((shape, index) => {
        docker([
          "create",
          "--name",
          names[index] ?? "",
          "--label",
          "omf.capture=1",
          ...shape.flags,
          IMAGE,
          "sleep",
          "3600",
        ]);
        const raw = JSON.parse(docker(["inspect", names[index] ?? ""])) as Array<{ Id: string }>;
        expect(raw).toHaveLength(1);
        // Written before the parse is asserted, so a document the parser rejects is on disk to study.
        if (process.env.OMF_CAPTURE_FIXTURES === "1") {
          writeFixture(shape.name, scrubInspect(raw, { id: raw[0]?.Id ?? "", ...scrubTargets() }));
        }
        expect(() => containerFactsFromInspect(raw), shape.name).not.toThrow();
      });
    } finally {
      for (const name of names) gatedDocker(["rm", "--force", "--volumes", name]);
    }
  }, 300_000);
});
