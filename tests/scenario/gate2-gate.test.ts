import { describe, expect, it } from "vitest";
import { runDecideDefer } from "../../src/cli/decide.js";
import { declareBudget } from "../../src/core/budget.js";
import type { NewEvent } from "../../src/core/ledger.js";
import { scorePct } from "../../src/feedback/ladder.js";
import { gate2Gate } from "../../src/scenario/gate2-gate.js";
import { EXPOSURE_LIMIT } from "../../src/scenario/types.js";
import { emptyEvidenceInputs } from "../../src/work/classify.js";
import type { GateContext } from "../../src/work/gates.js";
import type { WorkItem } from "../../src/work/types.js";
import { HUMAN, NOW, addOpen } from "../helpers/decision-fixture.js";
import { ledgerEvents } from "../helpers/enforcement-goal.js";
import { type LineFixture, ROUND1, ROUND2, plantCanary, sealStored, setupLine, writeYaml } from "../helpers/line-fixture.js";

const HOUR = 3_600_000;
const RUN = "r-20261014T091500Z-ab12";

function ctxOf(l: LineFixture, over: Partial<GateContext> = {}): GateContext {
  return {
    location: l.f.fx.location,
    item: l.f.item,
    events: l.f.fx.ledger.readVerified(),
    now: NOW,
    runId: RUN,
    round: 0,
    resumed: false,
    inputs: emptyEvidenceInputs(),
    ...over,
  };
}

const started = (item: WorkItem): WorkItem => ({ ...item, front: { ...item.front, state: "in_progress" } });

/** One release of a new score on a train digest of its own, preceded by its disclosure unit, the way releaseFeedback writes it. */
function releaseOne(l: LineFixture, index: number): void {
  const { goal_id, work_id } = l.f.scope;
  const digest = index.toString(16).padStart(64, "0");
  const unit: NewEvent = { actor: "omf", type: "budget.consumed", payload: { goal_id, kind: "disclosure", amount: 1 } };
  const event: NewEvent = {
    actor: "omf",
    type: "feedback.released",
    payload: {
      goal_id,
      work_id,
      run_id: RUN,
      train_digest: digest,
      round: 1,
      categories: [{ category: "interface", n: 10, pass: 4, score_pct: scorePct(4, 10), kind: "first" }],
      disclosure_units: 1,
    },
  };
  l.f.fx.ledger.appendWithMany(() => [unit, event]);
}

describe("gate2Gate", () => {
  it("is the GATE-2 gate with an evaluate function", () => {
    const gate = gate2Gate();
    expect(gate.id).toBe("GATE-2");
    expect(typeof gate.evaluate).toBe("function");
  });

  it("passes a strong sealed set with no reasons and stamps gate2.evaluated with the line's clock", async () => {
    const l = setupLine();
    await sealStored(l, writeYaml(l, "r2.yaml", ROUND2));
    const later = new Date(NOW.getTime() + HOUR);

    const result = await gate2Gate().evaluate(ctxOf(l, { now: later }));

    expect(result).toEqual({ gate: "GATE-2", verdict: "pass", reasons: [] });
    const evaluated = ledgerEvents(l.f.fx, "gate2.evaluated");
    expect(evaluated).toHaveLength(1);
    expect(evaluated[0]?.ts).toBe(later.toISOString());
  });

  it("maps back_to_S2 on a ready item to a fail without a stop route", async () => {
    const l = setupLine();
    const result = await gate2Gate().evaluate(ctxOf(l));
    expect(result).toEqual({ gate: "GATE-2", verdict: "fail", reasons: ["seal_missing"] });
  });

  it("maps back_to_S2 on an in_progress item to a fail that stops at J3: after the start S2 can only reuse the standing seal", async () => {
    const l = setupLine();
    await sealStored(l, writeYaml(l, "r1.yaml", ROUND1)); // links d-interface only, so d-cache is unlinked
    const result = await gate2Gate().evaluate(ctxOf(l, { item: started(l.f.item) }));
    expect(result).toEqual({ gate: "GATE-2", verdict: "fail", reasons: ["unlinked_decisions"], stop: "J3" });
    // and on a ready item the same set loops
    const ready = await gate2Gate().evaluate(ctxOf(l));
    expect(ready).toEqual({ gate: "GATE-2", verdict: "fail", reasons: ["unlinked_decisions"] });
  });

  it("stops at J3 with exposure_exhausted once the new-score releases reach the limit", async () => {
    const l = setupLine();
    await sealStored(l, writeYaml(l, "r2.yaml", ROUND2));
    declareBudget(l.f.fx.ledger, l.f.scope.goal_id, "disclosure", 50, HUMAN);
    for (let i = 1; i < EXPOSURE_LIMIT; i += 1) releaseOne(l, i);
    expect((await gate2Gate().evaluate(ctxOf(l))).verdict, "one release short of the limit").toBe("pass");

    releaseOne(l, EXPOSURE_LIMIT);
    const result = await gate2Gate().evaluate(ctxOf(l));
    expect(result).toEqual({ gate: "GATE-2", verdict: "fail", reasons: ["exposure_exhausted"], stop: "J3" });
  });

  it("stops at J2 when GATE-1 no longer passes for a ready item", async () => {
    const l = setupLine();
    await sealStored(l, writeYaml(l, "r2.yaml", ROUND2));
    addOpen(l.f, "d-wait");
    runDecideDefer(
      l.f.fx.location,
      l.f.workId,
      "d-wait",
      {
        owner: "dev",
        reason: "Waiting on the cache benchmark.",
        revisit_trigger: "After the benchmark lands.",
        default: "Keep the current behavior.",
        expires_at: new Date(NOW.getTime() + HOUR).toISOString(),
      },
      HUMAN,
      NOW,
    );
    const result = await gate2Gate().evaluate(ctxOf(l, { now: new Date(NOW.getTime() + 2 * HOUR) }));
    expect(result).toMatchObject({ gate: "GATE-2", verdict: "fail", stop: "J2" });
    expect(result.reasons).toContain("gate1_not_passing");
  });

  it("keeps the guard's closed code for a guard refusal, as not_run without a stop", async () => {
    const l = setupLine();
    plantCanary(l.f.fx.repo);
    const result = await gate2Gate().evaluate(ctxOf(l));
    expect(result).toEqual({ gate: "GATE-2", verdict: "not_run", reasons: ["sealed_material_in_repo"] });
    expect(ledgerEvents(l.f.fx, "gate2.evaluated"), "nothing was evaluated, so nothing is appended").toHaveLength(0);
  });

  it("lets a throw from its helpers escape, for the sequencer to turn into gate_error", async () => {
    const l = setupLine();
    // a feedback event of this goal that breaks its own rule stops exposureCountFor
    l.f.fx.ledger.append({
      actor: "omf",
      type: "feedback.released",
      payload: {
        goal_id: l.f.scope.goal_id,
        work_id: l.f.scope.work_id,
        run_id: RUN,
        train_digest: "a".repeat(64),
        round: 1,
        categories: [{ category: "interface", n: 10, pass: 4, score_pct: scorePct(4, 10), kind: "first" }],
        disclosure_units: 0,
      },
    });
    await expect(Promise.resolve().then(() => gate2Gate().evaluate(ctxOf(l)))).rejects.toThrow();
  });
});
