import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/core/ledger.js";
import { foldWorkBudget, microUsd, raiseWorkLimit } from "../../src/work/w-budget.js";
import { HUMAN } from "../helpers/decision-fixture.js";
import { type Script, finished, injectedGates, setupLine } from "../helpers/line-enforce.js";

// M3-D18 and M3b2-D3, D6, D17: rounds, per-item spend and re-entry are counted in the ledger, so a restarted
// process cannot reset them, and only a recorded J8 act (`raiseWorkLimit`, what `omf budget raise` calls)
// raises a limit. A forged budget event fails GATE-4 closed. Unknown spend neither stops a line nor passes
// silently.
const RUN = "r-20261014T000000Z-ab12";

describe("W-gate4-budget", () => {
  it("an exhausted round limit parks the item; a J8 raise lets the next entry run one more round on the same count", async () => {
    const line = setupLine({ maxRounds: 1 });
    const first = finished(
      (await line.exec({ gates: injectedGates(), scripts: { S6: () => ({ kind: "rework" }) } })).result,
    );
    expect(first).toMatchObject({
      outcome: "blocked",
      reason_code: "budget_exhausted",
      disposition: { action: "park" },
    });
    expect(first.handoff?.decision_required.j).toBe("J8");
    expect(line.state()).toBe("in_progress");

    raiseWorkLimit(line.location, line.workId, "rounds", 1, HUMAN);
    const second = await line.exec({ gates: injectedGates() });
    expect(second.ran[0]).toBe("S1");
    expect(finished(second.result).outcome).toBe("success");
    expect(line.rounds()).toEqual([1, 2]);
    // A restart is a fresh Ledger object over the same file: the counts are the ledger's.
    const budget = foldWorkBudget(new Ledger(line.location.dir).readVerified(), line.workId);
    expect(budget).toMatchObject({ rounds_started: 2, effective: { max_rounds: 2 } });
  });

  it("spend over the per-item limit stops the next entry before S1, until a J8 raise", async () => {
    const line = setupLine({ maxUsd: 0.01 });
    const spend: Script = (ctx) => {
      ctx.recordSpend(20_000);
      return { kind: "ok" };
    };
    const first = finished((await line.exec({ gates: injectedGates(), scripts: { S3: spend } })).result);
    expect(first).toMatchObject({ outcome: "blocked", reason_code: "budget_exhausted" });

    const again = await line.exec({ gates: injectedGates() });
    expect(finished(again.result)).toMatchObject({ outcome: "blocked", reason_code: "budget_exhausted" });
    expect(again.ran).toEqual([]);
    expect(line.rounds()).toEqual([1]);

    raiseWorkLimit(line.location, line.workId, "model_micro_usd", microUsd(1), HUMAN);
    expect((await line.exec({ gates: injectedGates() })).ran[0]).toBe("S1");
  });

  it("the same park reason three times stops the fourth entry at zero cost; a person's act resets the count", async () => {
    const line = setupLine();
    const infra: Script = () => ({ kind: "blocked", reason_code: "infra_failure" });
    for (let entry = 1; entry <= 3; entry += 1) {
      const run = await line.exec({ scripts: { S1: infra } });
      expect(finished(run.result), `entry ${entry}`).toMatchObject({
        outcome: "blocked",
        reason_code: "infra_failure",
      });
    }
    const stopped = await line.exec({ scripts: { S1: infra } });
    const done = finished(stopped.result);
    expect(done).toMatchObject({ outcome: "blocked", reason_code: "reentry_loop" });
    expect(done.handoff?.decision_required.j).toBe("J6");
    expect(stopped.ran).toEqual([]);

    raiseWorkLimit(line.location, line.workId, "rounds", 1, HUMAN);
    expect((await line.exec({ scripts: { S1: infra } })).ran).toEqual(["S1"]);
  });

  it("unknown spend neither stops the line nor passes silently", async () => {
    const line = setupLine();
    const unknown: Script = (ctx) => {
      ctx.recordSpend(null);
      return { kind: "ok" };
    };
    const done = finished((await line.exec({ gates: injectedGates(), scripts: { S3: unknown } })).result);
    expect(done.outcome).toBe("success");
    expect(done.evidence.recommendation).toBe("human_needed");
    expect(done.evidence.unverified_areas).toContainEqual({ code: "model_spend_unverifiable", decision_id: null });
    expect(done.evidence.self_metrics.budget_used.spend_unknown).toBe(true);
    expect(foldWorkBudget(line.events(), line.workId).spend).toEqual({ micro_usd: 0, unknown_count: 1 });
  });

  it("a rework that changes nothing is a stall and ends the item failed (J6)", async () => {
    const line = setupLine({ maxRounds: 3 });
    const same: Script = () => ({ kind: "rework", progress_digest: "a".repeat(64) });
    const done = finished((await line.exec({ gates: injectedGates(), scripts: { S6: same } })).result);
    expect(done).toMatchObject({ outcome: "flawed", reason_code: "stalled", disposition: { action: "fail" } });
    expect(done.handoff).toMatchObject({ reason_code: "stalled", decision_required: { j: "J6" } });
    expect(line.state()).toBe("failed");
    expect(line.rounds()).toEqual([1, 2]);
  });

  it.each<[string, string, string, Record<string, unknown>]>([
    ["work.spend by an agent", "agent:rogue", "work.spend", { run_id: RUN, station: "S3", micro_usd: 0 }],
    ["work.limit_raised by omf", "omf", "work.limit_raised", { kind: "rounds", amount: 50 }],
    [
      "work.limits_set by an agent",
      "agent:rogue",
      "work.limits_set",
      { run_id: RUN, max_rounds: 100, max_model_micro_usd: 1 },
    ],
    ["work.round with a gap", "omf", "work.round", { run_id: RUN, round: 7, prev_signature: null }],
  ])("a forged %s fails GATE-4 closed before S1", async (_name, actor, type, extra) => {
    const line = setupLine();
    line.f.fx.ledger.append({ actor, type, payload: { goal_id: line.f.fx.goalId, work_id: line.workId, ...extra } });
    const { result, ran } = await line.exec({ gates: injectedGates() });
    expect(finished(result)).toMatchObject({ outcome: "blocked", reason_code: "gate_blocked" });
    expect(ran).toEqual([]);
  });
});
