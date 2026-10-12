import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approvalScreen } from "../../src/cli/goal.js";
import { approveGoal } from "../../src/goal/approve.js";
import { lockFile } from "../../src/goal/metrics.js";
import { setupGoal } from "../helpers/goal.js";
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
});
