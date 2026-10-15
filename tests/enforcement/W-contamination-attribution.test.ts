import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { auditPath, loadAudit } from "../../src/audit/work-audit.js";
import { RUN_ID, classifyS5, s5Fixture } from "../helpers/s5-fixture.js";

// X-20: the aggregate canary scan says how many canaries reached the implementer, not whose. The station names the scenario,
// marks it contaminated once, and never lets a file in the vault decide which scenario that is.
describe("W-contamination-attribution", () => {
  it("marks the one scenario whose canary reached the implementer, once, across rounds", async () => {
    const fx = await s5Fixture();
    const hit = fx.index[0]!;
    const other = fx.index[1]!;
    fx.implementerLog.text = `agent notes ${hit.canary}`;
    const moved = () => fx.events("scenario.status_changed");

    const first = fx.ctx(1);
    expect(await fx.station.run(first)).toMatchObject({ kind: "ok" });
    expect(first.inputs.audit.canary_hits).toBe(1);
    expect(moved()).toHaveLength(1);
    expect(moved()[0]?.payload).toMatchObject({
      seal_id: hit.seal_id,
      scenario_ref: hit.scenario_ref,
      status: "contaminated",
      reason: "canary_hit",
    });
    expect(JSON.stringify(moved()[0]?.payload)).not.toContain(other.scenario_ref);
    expect(readFileSync(fx.line.f.fx.ledger.file, "utf8")).not.toContain(hit.canary);

    // Round 2 sees the same canary again: the audit of round 2 is its own, and the scenario is not marked a second time.
    fx.round.round = 2;
    const second = fx.ctx(2);
    expect(await fx.station.run(second)).toMatchObject({ kind: "ok" });
    expect(second.inputs.audit.canary_hits).toBe(1);
    expect(moved()).toHaveLength(1);
    expect(existsSync(auditPath(second.item.dir, RUN_ID, 2))).toBe(true);
    expect(fx.events("audit.completed")).toHaveLength(2);
  });

  it("marks nothing for a set that does not match its seal, and the round is still flawed", async () => {
    const fx = await s5Fixture();
    const forged = fx.tamper();
    fx.implementerLog.text = `agent notes ${forged}`;
    const ctx = fx.ctx();
    expect(await fx.station.run(ctx)).toMatchObject({ kind: "ok" });

    const report = loadAudit(ctx.item.dir, fx.scope(), fx.line.f.fx.ledger.readVerified());
    // The hit is kept, the scan can no longer claim to be complete, and no scenario is named.
    expect(report?.canary).toMatchObject({ status: "not_run", total: 1 });
    expect(fx.events("scenario.status_changed")).toHaveLength(0);
    expect(ctx.inputs.audit.canary_hits).toBe(1);
    expect(classifyS5(ctx.inputs)).toMatchObject({ outcome: "flawed", rule: "audit_flag" });
  });
});
