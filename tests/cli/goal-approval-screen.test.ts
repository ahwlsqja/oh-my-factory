import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approvalScreen } from "../../src/cli/goal.js";
import { approveGoal } from "../../src/goal/approve.js";
import { bandsLockInfo } from "../../src/goal/bands.js";
import { Ledger } from "../../src/core/ledger.js";
import { lockFile, proposeMetric } from "../../src/goal/metrics.js";
import { approveLegacy, setupGoal, writeBands } from "../helpers/goal.js";
import { commitAll } from "../helpers/tmp.js";
import { readFileSync } from "node:fs";

// J1 re-approval has to show why it is needed (spec §4.1, E1), or retyping the id is not a review.
describe("approvalScreen", () => {
  it("shows the goal and metric commands for a first approval", () => {
    const fx = setupGoal();
    const text = approvalScreen(fx.location, "g-fast").lines.join("\n");
    expect(text).toContain("goal g-fast:");
    expect(text).toContain('metric m-p95: ["sh","bench/p95.sh"]');
    expect(text).not.toContain("why approval is needed again");
  });

  it("shows the changed watched path and its diff when a metric's code changed", () => {
    const fx = setupGoal();
    approveGoal(fx.location, "g-fast", "human:dev");
    writeFileSync(join(fx.repo, "bench", "p95.sh"), "echo 100\n");
    commitAll(fx.repo, "faster benchmark");
    const text = approvalScreen(fx.location, "g-fast").lines.join("\n");
    expect(text).toContain("why approval is needed again");
    expect(text).toContain("watched path changed: bench/p95.sh (m-p95)");
    expect(text).toMatch(/bench\/p95\.sh\s+\|/);
  });

  it("shows lock problems such as a tampered lock", () => {
    const fx = setupGoal();
    approveGoal(fx.location, "g-fast", "human:dev");
    const file = lockFile(fx.location.dir, "g-fast", "m-p95");
    writeFileSync(file, readFileSync(file, "utf8").replace('"ms"', '"s"'));
    const text = approvalScreen(fx.location, "g-fast").lines.join("\n");
    expect(text).toContain("metric lock tampered: m-p95");
  });

  it("returns the hashes it showed, for approveGoal to hold the approval to", () => {
    const fx = setupGoal();
    const { expected } = approvalScreen(fx.location, "g-fast");
    expect(expected.semantic_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(expected.metrics).sort()).toEqual(["m-errors", "m-p95"]);
    expect(approveGoal(fx.location, "g-fast", "human:dev", undefined, expected).created).toBe(true);
  });

  it("shows the bands of every metric and returns the hash of what it showed", () => {
    const fx = setupGoal();
    writeBands(fx, "m-errors");
    const { lines, expected } = approvalScreen(fx.location, "g-fast");
    const text = lines.join("\n");
    expect(text).toContain("bands m-errors: baseline rolling_30d; 3sigma -> propose");
    expect(text).toContain("bands m-p95: none (not monitored)");
    expect(text).not.toContain("bands not locked");
    expect(expected.bands_sha256).toBe(bandsLockInfo(fx.location.dir, "g-fast", ["m-p95", "m-errors"]).sha256);
  });

  it("holds the approval to the bands that were shown", () => {
    const fx = setupGoal();
    const { expected } = approvalScreen(fx.location, "g-fast");
    writeBands(fx, "m-errors");
    expect(() => approveGoal(fx.location, "g-fast", "human:dev", undefined, expected)).toThrow(
      /changed after it was shown/,
    );
  });

  it("names an edited bands file as a reason for approving again", () => {
    const fx = setupGoal();
    approveGoal(fx.location, "g-fast", "human:dev");
    writeBands(fx, "m-errors");
    const text = approvalScreen(fx.location, "g-fast").lines.join("\n");
    expect(text).toContain("why approval is needed again");
    expect(text).toContain("bands changed: m-errors");
  });

  it("says so when the approval being replaced never locked its bands", () => {
    const fx = setupGoal();
    approveLegacy(fx);
    const text = approvalScreen(fx.location, "g-fast").lines.join("\n");
    expect(text).toContain("bands not locked (approved before M2b)");
  });

  it("escapes control and bidi characters from goal fields and metric argv so a person signs what they read", () => {
    const fx = setupGoal();
    writeFileSync(
      fx.goalFile,
      readFileSync(fx.goalFile, "utf8").replace(
        'title: "Say what this goal is in a few words"',
        'title: "fast\\x1b[2Jdone"',
      ),
    );
    proposeMetric(
      new Ledger(fx.location.dir),
      fx.location.dir,
      {
        metric_id: "m-p95",
        command: ["sh", "bench/p95.sh", "\u202eevil"],
        unit: "ms",
        watched_paths: ["bench/p95.sh"],
        image: null,
      },
      "human:dev",
    );
    const text = approvalScreen(fx.location, "g-fast").lines.join("\n");
    expect(text).toContain("\\u202e");
    expect(text).toContain("fast\\u001b[2Jdone");
    expect(text).not.toContain("\u202e");
    expect(text).not.toContain("\x1b");
  });
});
