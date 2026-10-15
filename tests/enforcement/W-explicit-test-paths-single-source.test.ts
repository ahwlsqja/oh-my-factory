import { describe, expect, it } from "vitest";
import { loadAudit, runAudit } from "../../src/audit/work-audit.js";
import { proveTest } from "../../src/gate/prove-test.js";
import { s5Fixture } from "../helpers/s5-fixture.js";

// X-17: what counts as a test outside the default globs is decided once, on the candidate reference, and prove-test and the
// audit must both see that decision. Two lists in two places would let a file be a test for one and a source file for the other.
describe("W-explicit-test-paths-single-source", () => {
  it("hands the same array object to prove-test and to the audit", async () => {
    const fx = await s5Fixture({ explicit: ["spec"] });
    const seen: { prove?: readonly string[]; audit?: readonly string[] } = {};
    fx.deps.steps = {
      proveTest: (input) => {
        seen.prove = input.explicitTestPaths;
        return proveTest(input);
      },
      runAudit: (input) => {
        seen.audit = input.explicitTestPaths;
        return runAudit(input);
      },
    };
    await fx.station.run(fx.ctx());

    expect(seen.prove).toBe(fx.candidate.explicitTestPaths);
    expect(seen.audit).toBe(seen.prove);
  });

  it.each([
    { explicit: [] as string[], tests: 1 },
    { explicit: ["spec"], tests: 2 },
  ])("a file under spec/ is a test for both or for neither (list $explicit)", async ({ explicit, tests }) => {
    const fx = await s5Fixture({ explicit, head: { "spec/cases.txt": "case one\n" } });
    const ctx = fx.ctx();
    await fx.station.run(ctx);

    const report = loadAudit(ctx.item.dir, fx.scope(), fx.line.f.fx.ledger.readVerified());
    expect(report?.prove_test).toMatchObject({ status: "PROVEN", test_paths: tests });
    expect(report?.tests_added).toBe(tests);
  });
});
