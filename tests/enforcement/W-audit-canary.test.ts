import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SURFACE_KINDS, textSurface } from "../../src/audit/canary-scan.js";
import { auditPath, auditSignals, runAudit } from "../../src/audit/work-audit.js";
import type { WorkAudit } from "../../src/audit/work-audit.js";
import { CANARY_TEXT, SCOPE, auditFixture, auditInput, surfacesWith } from "../helpers/audit-diff-fixture.js";
import { recordAndLoad } from "../helpers/audit-record.js";

// Spec §4.6 (F6), E2: a canary on any surface the implementer can read is a hit; the one place it may appear
// without being a hit is SUT and harness output, which is not a surface at all (no `SurfaceKind` member, so
// scanning it is a type error). The record carries the count and never the canary.
const fixture = () => auditFixture({ "src/a.ts": "1\n" }, { "src/a.ts": "2\n" });

describe("W-audit-canary", () => {
  it.each(SURFACE_KINDS)(
    "W-audit-canary-hit: a canary on the %s surface is found on that surface alone",
    async (kind) => {
      const report = await runAudit(auditInput(fixture(), { surfaces: surfacesWith(kind) }));
      expect(report.canary).toMatchObject({ status: "scanned", hits: [{ surface: kind, count: 1 }], total: 1 });

      const rec = recordAndLoad(report);
      expect(rec.payload).toMatchObject({ canary_status: "scanned", canary_hits: 1 });
      expect(rec.loaded).not.toBeNull();
      if (rec.loaded !== null) expect(auditSignals(rec.loaded).flawed).toContain("canary_hit");
      for (const text of [
        readFileSync(rec.ledger.file, "utf8"),
        readFileSync(auditPath(rec.itemDir, SCOPE.run_id), "utf8"),
      ]) {
        expect(text).not.toContain(CANARY_TEXT);
      }
    },
  );

  it("W-audit-canary-not-in-sut-output: a canary that only SUT or harness output holds is no audit hit", async () => {
    expect(SURFACE_KINDS).not.toContain("sut");
    expect(SURFACE_KINDS).not.toContain("harness");
    // @ts-expect-error SurfaceKind has no member for SUT or harness output, on purpose
    textSurface("sut", `server answered ${CANARY_TEXT}`);

    const report = await runAudit(auditInput(fixture()));
    expect(report.canary).toMatchObject({ status: "scanned", hits: [], total: 0 });
    expect(recordAndLoad(report).payload).toMatchObject({ canary_status: "scanned", canary_hits: 0 });
  });

  it("zero canaries, or a missing required surface, is not_run and an unverified area, never a clean scan (E7)", async () => {
    const noCanaries = await runAudit(auditInput(fixture(), { canaries: [] }));
    const missingSurface = await runAudit(auditInput(fixture(), { surfaces: surfacesWith().slice(1) }));
    for (const report of [noCanaries, missingSurface]) {
      expect(report.canary.status).toBe("not_run");
      const rec = recordAndLoad(report);
      expect(rec.payload).toMatchObject({ canary_status: "not_run" });
      expect(rec.loaded).not.toBeNull();
      expect(auditSignals(rec.loaded as WorkAudit).unverified).toContain("canary_not_scanned");
    }
  });
});
