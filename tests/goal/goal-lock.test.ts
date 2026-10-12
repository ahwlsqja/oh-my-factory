import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { budgetState } from "../../src/core/budget.js";
import { Ledger } from "../../src/core/ledger.js";
import { semanticHash } from "../../src/goal/goal-file.js";
import { ApprovalError, goalLockFile, latestApproval, lockGoal, readGoalLock } from "../../src/goal/goal-lock.js";
import { lockFile, metricSha256, readLock, readProposal } from "../../src/goal/metrics.js";
import { setupGoal } from "../helpers/goal.js";

describe("lockGoal", () => {
  it("locks the goal and its metrics as regime 1 and declares the rounds budget", () => {
    const fx = setupGoal();
    const approval = lockGoal(fx.location, "g-fast", "human:dev");
    expect(approval).toMatchObject({ regime: 1, metrics: ["m-p95", "m-errors"], approved_by: "human:dev" });
    expect(approval.first_approved_at).toBe(approval.approved_at);

    const goalLock = readGoalLock(fx.location.dir, "g-fast");
    expect(goalLock?.semantic_sha256).toBe(approval.semantic_sha256);
    expect(semanticHash(goalLock!.semantic)).toBe(approval.semantic_sha256);
    expect((statSync(goalLockFile(fx.location.dir, "g-fast")).mode & 0o777).toString(8)).toBe("600");

    const p95 = readLock(fx.location.dir, "g-fast", "m-p95");
    expect(p95).toMatchObject({ goal_id: "g-fast", regime: 1, approved_by: "human:dev", command: ["sh", "bench/p95.sh"] });
    expect(p95?.sha256).toBe(metricSha256(readProposal(fx.location.dir, "m-p95")!));
    expect((statSync(lockFile(fx.location.dir, "g-fast", "m-p95")).mode & 0o777).toString(8)).toBe("600");

    const types = new Ledger(fx.location.dir).readVerified().map((e) => e.type);
    expect(types.slice(-4)).toEqual(["metric.locked", "metric.locked", "goal.approved", "budget.declared"]);
    expect(budgetState(fx.ledger, "g-fast", "rounds")?.remaining).toBe(10);
  });

  it("starts a new regime on each lock and declares the budget only once", () => {
    const fx = setupGoal();
    const first = lockGoal(fx.location, "g-fast", "human:dev");
    const second = lockGoal(fx.location, "g-fast", "human:dev");
    expect(second.regime).toBe(2);
    expect(second.first_approved_at).toBe(first.approved_at);
    expect(readLock(fx.location.dir, "g-fast", "m-p95")?.regime).toBe(2);
    const declared = new Ledger(fx.location.dir).readVerified().filter((e) => e.type === "budget.declared");
    expect(declared).toHaveLength(1);
  });

  it("refuses agents, missing proposals and a target unit that does not match its metric", () => {
    expect(() => lockGoal(setupGoal().location, "g-fast", "agent:claude")).toThrow(ApprovalError);

    const missing = setupGoal({ guardrails: ["m-unknown"] });
    expect(() => lockGoal(missing.location, "g-fast", "human:dev")).toThrow(/m-unknown has no proposal/);

    const unit = setupGoal();
    writeFileSync(unit.goalFile, readFileSync(unit.goalFile, "utf8").replace("unit: ms", "unit: s"));
    expect(() => lockGoal(unit.location, "g-fast", "human:dev")).toThrow(/target unit s does not match metric m-p95 unit ms/);
    expect(latestApproval(new Ledger(unit.location.dir).readVerified(), "g-fast")).toBeNull();
  });

  it("refuses while a watched path has uncommitted changes", () => {
    const fx = setupGoal();
    writeFileSync(join(fx.repo, "bench", "p95.sh"), "echo 100\n");
    expect(() => lockGoal(fx.location, "g-fast", "human:dev")).toThrow(
      "commit or revert changes to watched paths before approving: bench/p95.sh",
    );
    expect(latestApproval(new Ledger(fx.location.dir).readVerified(), "g-fast")).toBeNull();
  });

  it("stops on a goal.approved event written by a non-person", () => {
    const fx = setupGoal();
    fx.ledger.append({
      actor: "agent:claude",
      type: "goal.approved",
      payload: { goal_id: "g-fast", regime: 1, semantic_sha256: "a".repeat(64), head_commit: "b".repeat(40), metrics: ["m-p95"] },
    });
    expect(() => latestApproval(fx.ledger.readVerified(), "g-fast")).toThrow(/goal.approved by agent:claude/);
  });
});
