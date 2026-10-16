import { describe, expect, it } from "vitest";
import { checkPlanFirst, planPath } from "../../src/implementer/plan.js";
import { buildChain, WORK_ID } from "../helpers/implementer-chain.js";
import { cleanInputs, finished, injectedGates, setupLine } from "../helpers/line-enforce.js";

// The first implementer commit is the plan and nothing else. Without it the result is flawed (plan_missing), not
// recommended, and still reviewable at J4. The plan is untrusted text: it reaches evidence only as plan_summary.
const PLAN = planPath(WORK_ID);
// What a repository may already track: another item's plan and context (a merged candidate), and root files of the same names.
const TRACKED_ALREADY = {
  ".omf/w-aaaaaaaaaaaa/plan.md": "an earlier plan\n",
  ".omf/w-aaaaaaaaaaaa/spec.md": "an earlier spec\n",
  "plan.md": "a root plan\n",
  "spec.md": "a root spec\n",
  "intent.md": "a root intent\n",
  "src/a.ts": "export {};\n",
};

describe("W-plan-first", () => {
  it("a base that already tracks other items' plans and root plan.md, spec.md, intent.md does not change the result", async () => {
    const ok = await buildChain({ base: TRACKED_ALREADY, work: [{ [PLAN]: "mine\n" }] });
    expect(await checkPlanFirst(ok.quarantine, WORK_ID, ok.context, ok.work)).toEqual({
      status: "ok",
      summary: "mine\n",
    });
    const root = await buildChain({ base: TRACKED_ALREADY, work: [{ [PLAN]: "mine\n", "plan.md": "edited\n" }] });
    expect(await checkPlanFirst(root.quarantine, WORK_ID, root.context, root.work)).toEqual({
      status: "missing",
      why: "first_commit_not_plan_only",
    });
  });

  it("through the line, an S3 stop on plan_missing is flawed, not recommended, submitted for review; S4 to S7 never run", async () => {
    const line = setupLine();
    const { result, ran } = await line.exec({
      gates: injectedGates(),
      scripts: { S3: () => ({ kind: "blocked", reason_code: "plan_missing" }) },
    });
    const done = finished(result);
    expect(done).toMatchObject({
      outcome: "flawed",
      reason_code: "plan_missing",
      disposition: { action: "submit", item_state: "awaiting_review", recommendation: "not_recommended" },
    });
    expect(done.evidence.recommendation_reasons[0]).toBe("plan_missing");
    expect(done.evidence.stations).toMatchObject({
      S3: "blocked",
      S4: "not_run",
      S5: "not_run",
      S6: "not_run",
      S7: "not_run",
    });
    expect(ran).toEqual(["S1", "S2", "S3"]);
    expect(line.state()).toBe("awaiting_review");
  });

  it("the plan text reaches evidence only as plan_summary, listed untrusted, without control characters, capped", async () => {
    const chain = await buildChain({
      base: { "src/a.ts": "export {};\n" },
      work: [{ [PLAN]: `Step one\u001b[31m\n${"y".repeat(5000)}` }],
    });
    const plan = await checkPlanFirst(chain.quarantine, WORK_ID, chain.context, chain.work);
    if (plan.status !== "ok") throw new Error("expected an ok plan");
    const { result } = await setupLine().exec({
      gates: injectedGates(),
      scripts: {
        S3: (ctx) => {
          ctx.inputs.plan_summary = plan.summary;
          return { kind: "ok" };
        },
        // The default S5 fills every input with clean values, plan_summary included; keep the one S3 produced.
        S5: (ctx) => {
          const kept = ctx.inputs.plan_summary;
          Object.assign(ctx.inputs, cleanInputs());
          ctx.inputs.plan_summary = kept;
          return { kind: "ok" };
        },
      },
    });
    const { evidence } = finished(result);
    expect(evidence.untrusted_fields).toEqual(["plan_summary", "implementer_notes"]);
    expect(evidence.plan_summary).toBe(plan.summary);
    expect(String(evidence.plan_summary).includes("\u001b")).toBe(false);
    expect(String(evidence.plan_summary).length).toBeLessThanOrEqual(2000);
  });
});
