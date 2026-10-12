import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/core/ledger.js";
import { approveGoal } from "../../src/goal/approve.js";
import { auditGoal } from "../../src/goal/audit.js";
import { lockFile } from "../../src/goal/metrics.js";
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
    expect(auditGoal(fx.location, "g-fast").problems).toEqual(["metric lock tampered: m-p95"]);
    expect(approveGoal(fx.location, "g-fast", "human:dev").created).toBe(true);
    expect(auditGoal(fx.location, "g-fast").problems).toEqual([]);
  });

  it("refuses agents and a draft with problems, and writes nothing", () => {
    const fx = setupGoal({ guardrails: ["m-unknown"] });
    const before = new Ledger(fx.location.dir).readVerified().length;
    expect(() => approveGoal(fx.location, "g-fast", "agent:claude")).toThrow(/only a person/);
    expect(() => approveGoal(fx.location, "g-fast", "human:dev")).toThrow(/m-unknown has no proposal/);
    expect(new Ledger(fx.location.dir).readVerified()).toHaveLength(before);
  });
});
