import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/core/ledger.js";
import {
  SIGNATURE_LIMIT,
  type ProgressInput,
  normalizeReason,
  previousProgressSig,
  progressSignature,
  signatureCounts,
  signatureOf,
  tripped,
} from "../../src/goal/signatures.js";
import { appendGoalEvent, appendTickEnded } from "../helpers/loop-events.js";
import { makeTempDir } from "../helpers/tmp.js";

const G = "g-fast";
const newLedger = (): Ledger => new Ledger(makeTempDir("omf-ledger-"));
const SIG = "measure|failed|metric command failed";

describe("normalizeReason", () => {
  it("maps run-specific numbers, hashes and paths to placeholders", () => {
    const first = normalizeReason("exit code 7 at /tmp/abc123def456/x.sh line 12");
    expect(first).toBe("exit code # at <path> line #");
    expect(normalizeReason("exit code 9 at /var/q/y.sh line 40")).toBe(first);
    expect(normalizeReason("Commit DEADBEEF1234 failed")).toBe("commit <hex> failed");
    expect(normalizeReason("bench/p95.sh   failed\n twice")).toBe("<path> failed twice");
  });

  it("maps a metric id to a placeholder, so the public tick output never names one (E2)", () => {
    expect(normalizeReason("metric lock tampered: m-p95")).toBe("metric lock tampered: <metric>");
    expect(normalizeReason("watched path changed: bench/x.sh (m-p95-checkout)")).toBe(
      "watched path changed: <path> (<metric>)",
    );
    expect(normalizeReason("metric m-x has no image")).toBe("metric <metric> has no image");
  });

  it("caps the result at 120 characters", () => {
    expect(normalizeReason("x".repeat(300))).toHaveLength(120);
  });
});

describe("signatureOf", () => {
  it("embeds the progress signature for ok outcomes, so a healthy loop does not repeat itself", () => {
    const outcome = { station: "reconcile", outcome_class: "ok", reason: "dispatched" } as const;
    const a = signatureOf(outcome, "a".repeat(64));
    const b = signatureOf(outcome, "b".repeat(64));
    expect(a).toBe(`reconcile|ok|dispatched|p:${"a".repeat(12)}`);
    expect(b).not.toBe(a);
    expect(signatureOf(outcome, null)).toBe("reconcile|ok|dispatched|p:-");
  });

  it("ignores progress for failure classes and does not count waiting outcomes", () => {
    const failed = { station: "measure", outcome_class: "failed", reason: "exit code 7 at /tmp/x/y.sh" } as const;
    expect(signatureOf(failed, "a".repeat(64))).toBe("measure|failed|exit code # at <path>");
    expect(signatureOf(failed, "b".repeat(64))).toBe(signatureOf(failed, null));
    expect(signatureOf({ station: "audit", outcome_class: "stopped", reason: "goal lock tampered" }, null)).toBe(
      "audit|stopped|goal lock tampered",
    );
    expect(signatureOf({ station: "reconcile", outcome_class: "empty", reason: "seed_lint" }, null)).toBe(
      "reconcile|empty|seed_lint",
    );
    expect(signatureOf({ station: "dispatch", outcome_class: "waiting", reason: "wip_full" }, null)).toBeNull();
  });
});

describe("progressSignature", () => {
  const base: ProgressInput = {
    regime: 1,
    items: [
      { work_id: "w-aaaaaaaaaaaa", state: "ready", updated_at: "2026-10-12T00:00:00.000Z" },
      { work_id: "w-bbbbbbbbbbbb", state: "done", updated_at: "2026-10-12T01:00:00.000Z" },
    ],
    metrics: [
      { metric_id: "m-p95", value: 312 },
      { metric_id: "m-errors", value: null },
    ],
  };

  it("is stable under item and metric order", () => {
    const shuffled: ProgressInput = { ...base, items: [...base.items].reverse(), metrics: [...base.metrics].reverse() };
    expect(progressSignature(shuffled)).toBe(progressSignature(base));
    expect(progressSignature(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when an item timestamp or state, a metric value, or the regime changes, and only then", () => {
    const sig = progressSignature(base);
    const touched = { ...base, items: [{ ...base.items[0]!, updated_at: "2026-10-12T00:00:01.000Z" }, base.items[1]!] };
    const moved = { ...base, items: [{ ...base.items[0]!, state: "in_progress" as const }, base.items[1]!] };
    const measured = { ...base, metrics: [{ metric_id: "m-p95", value: 313 }, base.metrics[1]!] };
    const regime = { ...base, regime: 2 };
    for (const changed of [touched, moved, measured, regime]) expect(progressSignature(changed)).not.toBe(sig);
    expect(progressSignature(structuredClone(base))).toBe(sig);
  });
});

describe("previousProgressSig", () => {
  it("returns the progress signature of the latest tick whose model answered, skipping failed calls", () => {
    const ledger = newLedger();
    appendTickEnded(ledger, G, { reconciled: true, progress_sig: "a".repeat(64) });
    appendTickEnded(ledger, G, { reconciled: false, progress_sig: "b".repeat(64) });
    expect(previousProgressSig(ledger.readVerified(), G)).toBe("a".repeat(64));
  });

  it("is null with no reconciled tick, for another goal, and after a resume or an approval", () => {
    const ledger = newLedger();
    expect(previousProgressSig(ledger.readVerified(), G)).toBeNull();
    appendTickEnded(ledger, G, { reconciled: true, progress_sig: "a".repeat(64) });
    expect(previousProgressSig(ledger.readVerified(), "g-other")).toBeNull();
    appendGoalEvent(ledger, "goal.resumed", G, "human:dev", { from: "blocked_on_user" });
    expect(previousProgressSig(ledger.readVerified(), G)).toBeNull();
  });
});

describe("signature breaker", () => {
  it("trips on the third occurrence: two earlier ticks plus the current one", () => {
    const ledger = newLedger();
    appendTickEnded(ledger, G, { signatures: [SIG] });
    appendTickEnded(ledger, G, { signatures: [SIG] });
    const counts = signatureCounts(ledger.readVerified(), G);
    expect(counts.get(SIG)).toBe(2);
    expect(tripped(counts, [SIG])).toBe(SIG);
    expect(tripped(counts, [])).toBeNull();
    expect(tripped(counts, ["measure|failed|something else"])).toBeNull();
  });

  it("does not trip on two in total, and counts repeats inside the current tick", () => {
    const ledger = newLedger();
    appendTickEnded(ledger, G, { signatures: [SIG] });
    const counts = signatureCounts(ledger.readVerified(), G);
    expect(tripped(counts, [SIG])).toBeNull();
    expect(tripped(counts, [SIG, SIG])).toBe(SIG);
    expect(tripped(new Map(), [SIG, SIG])).toBeNull();
    expect(SIGNATURE_LIMIT).toBe(3);
  });

  it("is not reset by successful ticks in between", () => {
    const ledger = newLedger();
    appendTickEnded(ledger, G, { signatures: [SIG] });
    appendTickEnded(ledger, G, { signatures: ["reconcile|ok|dispatched|p:aaaaaaaaaaaa"], reconciled: true });
    appendTickEnded(ledger, G, { signatures: [SIG] });
    expect(signatureCounts(ledger.readVerified(), G).get(SIG)).toBe(2);
  });

  it("restarts after goal.resumed and after a later goal.approved", () => {
    const ledger = newLedger();
    appendTickEnded(ledger, G, { signatures: [SIG] });
    appendTickEnded(ledger, G, { signatures: [SIG] });
    appendGoalEvent(ledger, "goal.resumed", G, "human:dev", { from: "blocked_on_user" });
    expect(signatureCounts(ledger.readVerified(), G).get(SIG)).toBeUndefined();
    appendTickEnded(ledger, G, { signatures: [SIG] });
    appendGoalEvent(ledger, "goal.approved", G, "human:dev");
    expect(signatureCounts(ledger.readVerified(), G).size).toBe(0);
  });

  it("ignores other goals and survives a process restart (a fresh Ledger reads the same counts)", () => {
    const ledger = newLedger();
    appendTickEnded(ledger, G, { signatures: [SIG] });
    appendTickEnded(ledger, "g-other", { signatures: [SIG] });
    appendTickEnded(ledger, G, { signatures: [SIG] });
    const fresh = new Ledger(ledger.dir);
    expect(signatureCounts(fresh.readVerified(), G).get(SIG)).toBe(2);
  });

  it("refuses a malformed goal.tick_ended payload instead of skipping it", () => {
    const ledger = newLedger();
    appendGoalEvent(ledger, "goal.tick_ended", G, "omf", { tick_id: "t-x", signatures: "not-a-list" });
    expect(() => signatureCounts(ledger.readVerified(), G)).toThrow(/invalid goal\.tick_ended event at seq 1/);
    expect(() => previousProgressSig(ledger.readVerified(), G)).toThrow(/invalid goal\.tick_ended event at seq 1/);
  });
});
