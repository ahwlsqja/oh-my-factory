import { describe, expect, it } from "vitest";
import { createArgv } from "../../src/container/argv.js";
import { containerSpecFor, goldenFor } from "../../src/container/golden.js";
import { pinnedImage } from "../../src/container/image-ref.js";
import type { ImageInfo } from "../../src/container/runtime.js";
import type { ImageId } from "../../src/container/spec.js";
import { AUTHOR_BASE, FIXTURE_AUTHOR_LIMITS, FIXTURE_RUN_ID, FIXTURE_WORK_ID } from "../helpers/container-fixture.js";
import { FORBIDDEN } from "../helpers/measure-fixture.js";

// covers: S5.3.author-container-argv
// W-seal-no-forbidden-mounts: the sealing author sees an item's intent, spec and interface contract and an output directory, and
// nothing else. Those are content written into tmpfs, not host paths: the create argv has no bind, volume or device flag, the
// golden allows no host path, and a daemon that reports a bind mount of the vault, the home or the repository measures L1
// before the container starts (spec §5.3, §11 rule 1).
const DESTINATIONS = ["/agent", "/in", "/out", "/tmp"];
const BIND_FLAGS = /^(--(mount|volume|device|publish|volumes-from)(=|$)|-v$|-p$)/;
const IMAGE: ImageInfo = { id: `sha256:${"d".repeat(64)}` as ImageId, env_names: ["PATH"], user: "", volumes: [] };

describe("the author create argv carries no host path", () => {
  it("has no bind, volume or device flag, and every --tmpfs names one of the four destinations with no source", () => {
    for (const context of [null, "colima-omf-m3f"]) {
      for (const size of [1, 4096]) {
        const author = {
          ...FIXTURE_AUTHOR_LIMITS,
          tmp_tmpfs_mb: size,
          in_tmpfs_mb: size,
          out_tmpfs_mb: size,
          agent_tmpfs_mb: size,
        };
        const spec = containerSpecFor({
          role: "author",
          image: pinnedImage(AUTHOR_BASE),
          labels: { work_id: FIXTURE_WORK_ID, run_id: FIXTURE_RUN_ID, round: 1 },
          serial: 1,
          limits: { kind: "author", author },
        });
        const argv = createArgv(spec, context);
        expect(argv.filter((element) => BIND_FLAGS.test(element))).toEqual([]);
        expect(argv.filter((element) => element.includes("docker.sock"))).toEqual([]);
        const mounts = argv.filter((_element, at) => argv[at - 1] === "--tmpfs");
        expect(mounts.map((mount) => mount.split(":")[0]).sort()).toEqual(DESTINATIONS);
        expect(mounts.every((mount) => mount.split(":").length === 2)).toBe(true);
      }
    }
  });
});

describe("the author golden allows no host path", () => {
  it("lists four mounts, each with an empty source", () => {
    const golden = goldenFor({ role: "author", image: IMAGE, forbidden: FORBIDDEN });
    expect(golden.allowed_mounts.map((mount) => mount.destination).sort()).toEqual(DESTINATIONS);
    expect(golden.allowed_mounts.map((mount) => mount.source)).toEqual(["", "", "", ""]);
    expect(golden.forbidden_paths).toEqual(FORBIDDEN);
  });
});
