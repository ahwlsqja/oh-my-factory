import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SymlinkRefusedError } from "../../src/core/safe-fs.js";
import { assertLineSafe, guardRefusal, locationEnv } from "../../src/vault/line-guard.js";
import { PokaYokeError } from "../../src/vault/pokayoke.js";
import { beginRun } from "../../src/work/w-run.js";
import { addInterface, addOpen, setupDecisionItem } from "../helpers/decision-fixture.js";
import { ledgerEvents, setupEnforcementGoal } from "../helpers/enforcement-goal.js";

/** A canary-shaped string built at run time: a full literal in the source would trip OMF on OMF (M3c-D13). */
function plant(repo: string): void {
  writeFileSync(join(repo, "notes.txt"), `leftover omf-canary-${"ab".repeat(16)}\n`);
}

describe("line guard", () => {
  it("derives its environment from the location, never from process.env", () => {
    const fx = setupEnforcementGoal();
    expect(locationEnv(fx.location)).toEqual({ OMF_HOME: fx.env.OMF_HOME });
  });

  it("passes on a clean repository and state", () => {
    const fx = setupEnforcementGoal();
    expect(() => assertLineSafe(fx.location, fx.env)).not.toThrow();
    expect(() => assertLineSafe(fx.location)).not.toThrow();
  });

  it("refuses sealed material in the repository", () => {
    const fx = setupEnforcementGoal();
    plant(fx.repo);
    let caught: unknown;
    try {
      assertLineSafe(fx.location);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PokaYokeError);
    expect(guardRefusal(caught)).toBe("sealed_material_in_repo");
  });

  it("refuses a symlink planted under the project state", () => {
    const fx = setupEnforcementGoal();
    symlinkSync(fx.home, join(fx.location.dir, "goals", "evil"));
    let caught: unknown;
    try {
      assertLineSafe(fx.location);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SymlinkRefusedError);
    expect(guardRefusal(caught)).toBe("symlink_in_state");
  });

  it("maps any other error to null, so a real fault is rethrown by the caller", () => {
    expect(guardRefusal(new Error("boom"))).toBeNull();
  });

  it("stops every decide write when sealed material is in the repository, and appends nothing", () => {
    const f = setupDecisionItem();
    addInterface(f);
    const before = ledgerEvents(f.fx).length;
    plant(f.fx.repo);
    expect(() => addOpen(f, "d-other")).toThrow(PokaYokeError);
    expect(ledgerEvents(f.fx).length).toBe(before);
  });

  it("stops beginRun, M3b1's run entry, when sealed material is in the repository: no claim and no ledger write", () => {
    const f = setupDecisionItem();
    const before = ledgerEvents(f.fx).length;
    plant(f.fx.repo);
    expect(() => beginRun({ location: f.fx.location, workId: f.workId })).toThrow(PokaYokeError);
    expect(ledgerEvents(f.fx).length).toBe(before);
    expect(existsSync(join(f.item.dir, "claim.lock"))).toBe(false);
  });
});
