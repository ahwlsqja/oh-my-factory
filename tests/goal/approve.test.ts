import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/core/ledger.js";
import { approveGoal } from "../../src/goal/approve.js";
import { auditGoal } from "../../src/goal/audit.js";
import { semanticHash, readGoal } from "../../src/goal/goal-file.js";
import { lockFile, metricSha256, proposeMetric, readProposal } from "../../src/goal/metrics.js";
import { setupGoal } from "../helpers/goal.js";
import { commitAll } from "../helpers/tmp.js";

const count = (dir: string, type: string): number => new Ledger(dir).readVerified().filter((e) => e.type === type).length;

describe("approveGoal", () => {
  it("approves a draft as regime 1", () => {
    const fx = setupGoal();
    const result = approveGoal(fx.location, "g-fast", "human:dev");
    expect(result).toMatchObject({ created: true, approval: { regime: 1 } });
    expect(auditGoal(fx.location, "g-fast").state).toBe("approved");
  });

  it("does nothing when the approved goal is unchanged", () => {
    const fx = setupGoal();
    approveGoal(fx.location, "g-fast", "human:dev");
    const before = new Ledger(fx.location.dir).readVerified().length;
    const again = approveGoal(fx.location, "g-fast", "human:dev");
    expect(again).toMatchObject({ created: false, approval: { regime: 1 } });
    expect(new Ledger(fx.location.dir).readVerified()).toHaveLength(before);
  });

  it("starts regime 2 after a watched path changes, without a second budget", () => {
    const fx = setupGoal();
    approveGoal(fx.location, "g-fast", "human:dev");
    writeFileSync(join(fx.repo, "bench", "p95.sh"), "echo 100\n");
    commitAll(fx.repo, "faster benchmark");
    expect(approveGoal(fx.location, "g-fast", "human:dev")).toMatchObject({ created: true, approval: { regime: 2 } });
    expect(auditGoal(fx.location, "g-fast")).toMatchObject({ state: "approved", regime_changes: [] });
    expect(count(fx.location.dir, "budget.declared")).toBe(1);
  });

  it("repairs a tampered lock by approving again", () => {
    const fx = setupGoal();
    approveGoal(fx.location, "g-fast", "human:dev");
    const file = lockFile(fx.location.dir, "g-fast", "m-p95");
    writeFileSync(file, readFileSync(file, "utf8").replace("bench/p95.sh\"", "bench/other.sh\""));
    const broken = auditGoal(fx.location, "g-fast");
    expect(broken.problems).toEqual(["metric lock tampered: m-p95"]);
    expect(broken.state).toBe("tampered");
    expect(approveGoal(fx.location, "g-fast", "human:dev").created).toBe(true);
    const repaired = auditGoal(fx.location, "g-fast");
    expect(repaired.problems).toEqual([]);
    expect(repaired.state).toBe("approved");
  });

  it("refuses agents and a draft with problems, and writes nothing", () => {
    const fx = setupGoal({ guardrails: ["m-unknown"] });
    const before = new Ledger(fx.location.dir).readVerified().length;
    expect(() => approveGoal(fx.location, "g-fast", "agent:claude")).toThrow(/only a person/);
    expect(() => approveGoal(fx.location, "g-fast", "human:dev")).toThrow(/m-unknown has no proposal/);
    expect(new Ledger(fx.location.dir).readVerified()).toHaveLength(before);
  });

  it("refuses when the goal or a metric changed after it was shown, and writes nothing", () => {
    const fx = setupGoal();
    const goal = readGoal(fx.location.dir, "g-fast").front;
    const expected = {
      semantic_sha256: semanticHash(goal),
      metrics: {
        "m-p95": metricSha256(readProposal(fx.location.dir, "m-p95")!),
        "m-errors": metricSha256(readProposal(fx.location.dir, "m-errors")!),
      },
    };
    proposeMetric(
      fx.ledger,
      fx.location.dir,
      { metric_id: "m-p95", command: ["sh", "-c", "echo 1"], unit: "ms", watched_paths: ["bench/p95.sh"], image: null },
      "human:dev",
    );
    const before = new Ledger(fx.location.dir).readVerified().length;
    expect(() => approveGoal(fx.location, "g-fast", "human:dev", undefined, expected)).toThrow(/changed after it was shown/);
    expect(new Ledger(fx.location.dir).readVerified()).toHaveLength(before);

    writeFileSync(fx.goalFile, readFileSync(fx.goalFile, "utf8").replace("value: 250", "value: 400"));
    expect(() => approveGoal(fx.location, "g-fast", "human:dev", undefined, expected)).toThrow(/changed after it was shown/);
  });
});
