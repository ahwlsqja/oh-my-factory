import { copyFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { auditHeadSha, auditPath, loadAudit, recordAudit } from "../../src/audit/work-audit.js";
import { Ledger } from "../../src/core/ledger.js";
import { validate } from "../../src/core/schema.js";
import { auditCompletedEvent } from "../../src/gate/events.js";
import { HEAD_SHA, SCOPE } from "../helpers/audit-diff-fixture.js";
import { cleanAudit } from "../helpers/gate3-parts.js";
import { makeTempDir } from "../helpers/tmp.js";

// A rework run judges several rounds and each has its own audit, so the audit is keyed by (run, round): one record per
// round, and a round-1 audit can never answer round 2.
const ROUND2 = { ...SCOPE, round: 2 };
const HEAD2 = "c".repeat(40);

describe("W-audit-keyed-by-round", () => {
  it("records one audit per round of a run, refuses a second for the same round, and keeps the rounds apart", () => {
    const itemDir = makeTempDir("omf-item-");
    const ledger = new Ledger(makeTempDir("omf-ledger-"));
    recordAudit(ledger, SCOPE, itemDir, cleanAudit(), HEAD_SHA);
    const before = ledger.readVerified();
    expect(loadAudit(itemDir, ROUND2, before)).toBeNull();
    expect(auditHeadSha(before, ROUND2)).toBeNull();
    copyFileSync(auditPath(itemDir, SCOPE.run_id, 1), auditPath(itemDir, SCOPE.run_id, 2));
    expect(loadAudit(itemDir, ROUND2, before)).toBeNull(); // a copied file has no round-2 event behind it

    recordAudit(ledger, ROUND2, itemDir, cleanAudit({ tests_added: 5 }), HEAD2);
    expect(() => recordAudit(ledger, SCOPE, itemDir, cleanAudit(), HEAD_SHA)).toThrow(/already recorded/);
    expect(() => recordAudit(ledger, ROUND2, itemDir, cleanAudit(), HEAD2)).toThrow(/already recorded/);
    const events = ledger.readVerified();
    expect(events).toHaveLength(2);
    expect(loadAudit(itemDir, SCOPE, events)?.tests_added).toBe(1);
    expect(loadAudit(itemDir, ROUND2, events)?.tests_added).toBe(5);
    expect([auditHeadSha(events, SCOPE), auditHeadSha(events, ROUND2)]).toEqual([HEAD_SHA, HEAD2]);
  });

  it("names the file audit-<round>.json and refuses a round below 1", () => {
    expect(auditPath("/item", SCOPE.run_id, 3)).toBe(`/item/runs/${SCOPE.run_id}/audit-3.json`);
    expect(() => auditPath("/item", SCOPE.run_id, 0)).toThrow(RangeError);
    expect(loadAudit("/item", { ...SCOPE, round: 0 }, [])).toBeNull();
  });

  it("requires round and head_sha in the event schema", () => {
    const payload = auditCompletedEvent(SCOPE, cleanAudit(), HEAD_SHA).payload;
    const accepts = (candidate: Record<string, unknown>): boolean =>
      validate("gate-event.schema.json", { type: "audit.completed", payload: candidate }).ok;
    const without = (key: string): Record<string, unknown> =>
      Object.fromEntries(Object.entries(payload).filter(([name]) => name !== key));
    expect(accepts(payload)).toBe(true);
    expect([accepts(without("round")), accepts(without("head_sha"))]).toEqual([false, false]);
    expect([accepts({ ...payload, round: 0 }), accepts({ ...payload, head_sha: "HEAD" })]).toEqual([false, false]);
  });
});
