import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { legacyImageWarnings, unpinnedImageWarning } from "../../src/adapters/measure-cmd.js";
import { ApprovalError, lockGoal } from "../../src/goal/goal-lock.js";
import { lockFile, proposalFile } from "../../src/goal/metrics.js";
import { omf } from "../helpers/cli.js";
import { type GoalFixture, approveLegacy, setupGoal } from "../helpers/goal.js";
import { makeTempDir } from "../helpers/tmp.js";

// M3-D13: an image is pinned by digest or it is not an image OMF runs. New proposals and new locks need the digest;
// a lock that J1 already approved with a tag is grandfathered, and says so on every run instead of being refused.

/** Rewrites the stored proposal of m-p95 to carry `image`, the way a proposal made before the rule would look. */
function setImage(fx: GoalFixture, image: string): void {
  const file = proposalFile(fx.location.dir, "m-p95");
  const proposal = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...proposal, image }));
}

describe("W-digest-required", () => {
  it("refuses to lock a goal whose metric proposal holds a tag, and creates no lock", () => {
    const fx = setupGoal({ guardrails: [] });
    setImage(fx, "alpine:3.20");
    const lock = () => lockGoal(fx.location, "g-fast", "human:dev");
    expect(lock).toThrow(ApprovalError);
    expect(lock).toThrow(
      "metric m-p95 image alpine:3.20 is not pinned by digest; use <name>@sha256:<64 hex digits>; nothing was approved",
    );
    expect(existsSync(lockFile(fx.location.dir, "g-fast", "m-p95"))).toBe(false);
    const types = fx.ledger.readVerified().map((event) => event.type);
    expect(types).not.toContain("metric.locked");
    expect(types).not.toContain("goal.approved");
  });

  it("locks the same goal once the proposal carries a digest", () => {
    const fx = setupGoal({ guardrails: [] });
    setImage(fx, `alpine@sha256:${"a".repeat(64)}`);
    expect(lockGoal(fx.location, "g-fast", "human:dev").regime).toBe(1);
  });

  it("keeps measuring a lock approved with a tag, and prints exactly one warning line", () => {
    const fx = setupGoal({ guardrails: [] });
    setImage(fx, "alpine:3.20");
    approveLegacy(fx);
    const bin = makeTempDir("omf-fake-docker-");
    writeFileSync(join(bin, "docker"), "#!/bin/sh\necho 300\n");
    chmodSync(join(bin, "docker"), 0o755);
    const result = omf(["goal", "measure", "g-fast"], fx.repo, fx.home, { PATH: `${bin}:${process.env.PATH}` });
    expect(result.stdout).toContain("target m-p95: 300 ms");
    const warnings = result.stderr
      .split("\n")
      .filter((line) => line.startsWith("warning: metric m-p95 image alpine:3.20"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("is not pinned by digest");
  });

  it("warns about nothing for a pinned image, no image, or a goal that is not approved", () => {
    const pinned = { metric_id: "m-x", image: `alpine@sha256:${"a".repeat(64)}` };
    expect(unpinnedImageWarning(pinned)).toBeNull();
    expect(unpinnedImageWarning({ metric_id: "m-x", image: null })).toBeNull();
    expect(unpinnedImageWarning({ metric_id: "m-x", image: "a\u001b[31mb:1" })).not.toContain("\u001b");
    const fx = setupGoal({ guardrails: [] });
    expect(legacyImageWarnings(fx.location.dir, "g-fast")).toEqual([]);
    lockGoal(fx.location, "g-fast", "human:dev");
    expect(legacyImageWarnings(fx.location.dir, "g-fast")).toEqual([]);
  });
});
