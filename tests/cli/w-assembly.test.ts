// covers: S5.3.seal-refuses-out-of-order
import { describe, expect, it } from "vitest";
import { checkOrder, openRuntime } from "../../src/cli/w-assembly.js";
import { CONFIG_DEFAULTS } from "../../src/core/config.js";
import { claimItem, releaseItem } from "../../src/work/claim.js";
import { beginRun } from "../../src/work/w-run.js";
import { type LineFixture, appendWorkStarted, setupLine } from "../helpers/line-fixture.js";
import { configureSeal, plantStandingSeal } from "../helpers/seal-cli.js";

const now = (): Date => new Date();
const order = (l: LineFixture, verb: "seal" | "run" | "report") => checkOrder(l.f.fx.location, l.f.workId, verb, now());

/** Starts the item the way a run killed after S3 leaves it: in_progress, claim released. */
function startItem(l: LineFixture): void {
  const run = beginRun({ location: l.f.fx.location, workId: l.f.workId, now });
  run.start();
  run.abandon();
}

describe("openRuntime", () => {
  it("is null without a docker_context and a runtime with one", () => {
    expect(openRuntime(CONFIG_DEFAULTS, {})).toBeNull();
    const config = { ...CONFIG_DEFAULTS, judge: { ...CONFIG_DEFAULTS.judge, docker_context: "colima-omf-m3f" } };
    expect(typeof openRuntime(config, { HOME: "/home/x" })?.info).toBe("function");
  });
});

describe("checkOrder with no seal", () => {
  it("names GATE-1 while the decisions are open, for seal and run (exit 3)", () => {
    const l = setupLine({ decisions: false });
    for (const verb of ["seal", "run"] as const) {
      expect(order(l, verb)).toMatchObject({
        ok: false,
        missing: "GATE-1",
        exit: 3,
        message: `GATE-1 is not passing (J2): omf decide lint ${l.f.workId}`,
      });
    }
  });

  it("lets seal start, names GATE-2 for run and S7 for report, and names an unknown item", () => {
    const l = setupLine();
    expect(order(l, "seal")).toMatchObject({ ok: true, warnings: [] });
    expect(order(l, "run")).toMatchObject({
      ok: false,
      missing: "GATE-2",
      exit: 2,
      message: `GATE-2 has no passing seal for the current decisions: run omf seal ${l.f.workId}`,
    });
    expect(order(l, "report")).toMatchObject({
      ok: false,
      missing: "S7",
      exit: 2,
      message: `no trusted evidence (S7 has not run): run omf run ${l.f.workId}`,
    });
    expect(checkOrder(l.f.fx.location, "w-000000000000", "seal", now())).toMatchObject({
      ok: false,
      missing: "item",
      exit: 2,
      message: "unknown work item w-000000000000",
    });
  });

  it("refuses seal and run while a live run holds the claim", () => {
    const l = setupLine();
    claimItem(l.f.item.dir);
    try {
      for (const verb of ["seal", "run"] as const) {
        expect(order(l, verb)).toMatchObject({ ok: false, missing: "item", exit: 2 });
      }
    } finally {
      releaseItem(l.f.item.dir);
    }
  });

  it("lets run repair an item one step behind the ledger, and refuses seal and report for it", () => {
    const l = setupLine();
    appendWorkStarted(l); // the event is in the ledger, item.md still says ready
    expect(order(l, "run")).toMatchObject({ ok: true, warnings: [expect.stringContaining("one step behind")] });
    expect(order(l, "seal")).toMatchObject({ ok: false, missing: "item", exit: 2 });
  });
});

describe("checkOrder with a standing seal", () => {
  it("an unmeasured author: seal may reseal a ready item, run warns, a started item cannot be resealed", async () => {
    const l = setupLine();
    configureSeal(l);
    await plantStandingSeal(l, { measured: false });
    expect(order(l, "seal")).toMatchObject({ ok: true, warnings: [] });
    const run = order(l, "run");
    expect(run).toMatchObject({ ok: true });
    expect(run.ok && run.warnings.join(" ")).toContain("isolation_unmeasured");
    startItem(l);
    expect(order(l, "seal")).toMatchObject({ ok: false, missing: "GATE-2", exit: 2 });
    expect(order(l, "run")).toMatchObject({ ok: true });
  });

  it("a measured author: no warning, and seal is still allowed once the item has started", async () => {
    const l = setupLine();
    configureSeal(l);
    await plantStandingSeal(l, { measured: true });
    expect(order(l, "run")).toMatchObject({ ok: true, warnings: [] });
    startItem(l);
    expect(order(l, "seal")).toMatchObject({ ok: true, warnings: [] });
  });
});
