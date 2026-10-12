import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GENESIS_HASH, Ledger, LedgerCorruptError } from "../../src/core/ledger.js";
import { makeTempDir } from "../helpers/tmp.js";

const newLedger = (): Ledger => new Ledger(makeTempDir("omf-ledger-"));

function rewriteLine(ledger: Ledger, index: number, edit: (event: Record<string, unknown>) => void): void {
  const lines = readFileSync(ledger.file, "utf8").trimEnd().split("\n");
  const event = JSON.parse(lines[index] ?? "") as Record<string, unknown>;
  edit(event);
  lines[index] = JSON.stringify(event);
  writeFileSync(ledger.file, `${lines.join("\n")}\n`);
}

describe("Ledger", () => {
  it("chains events and verifies", () => {
    const ledger = newLedger();
    const first = ledger.append({ actor: "omf", type: "project.initialized", payload: { a: 1 } });
    const second = ledger.append({ actor: "human:dev", type: "budget.declared", payload: { goal_id: "g-x", rounds: 3 } });
    expect(first.seq).toBe(1);
    expect(first.prev_hash).toBe(GENESIS_HASH);
    expect(second.seq).toBe(2);
    expect(second.prev_hash).toBe(first.hash);
    expect(ledger.verify()).toEqual({ ok: true, count: 2, head: second.hash });
  });

  it("verifies an empty or missing ledger as ok with zero events", () => {
    expect(newLedger().verify()).toEqual({ ok: true, count: 0, head: GENESIS_HASH });
  });

  it("detects a tampered payload", () => {
    const ledger = newLedger();
    ledger.append({ actor: "omf", type: "project.initialized", payload: { a: 1 } });
    rewriteLine(ledger, 0, (event) => {
      event.payload = { a: 2 };
    });
    expect(ledger.verify()).toEqual({ ok: false, seq: 1, reason: "hash mismatch" });
  });

  it("detects a deleted event", () => {
    const ledger = newLedger();
    ledger.append({ actor: "omf", type: "project.initialized", payload: {} });
    ledger.append({ actor: "omf", type: "project.touched", payload: {} });
    const lines = readFileSync(ledger.file, "utf8").trimEnd().split("\n");
    writeFileSync(ledger.file, `${lines[1]}\n`);
    expect(ledger.verify()).toEqual({ ok: false, seq: 1, reason: "seq is 2" });
  });

  it("detects an unparseable line", () => {
    const ledger = newLedger();
    ledger.append({ actor: "omf", type: "project.initialized", payload: {} });
    writeFileSync(ledger.file, `${readFileSync(ledger.file, "utf8")}{not json\n`);
    expect(ledger.verify()).toEqual({ ok: false, seq: 2, reason: "unparseable line" });
  });

  it("refuses to append to a corrupt ledger", () => {
    const ledger = newLedger();
    ledger.append({ actor: "omf", type: "project.initialized", payload: { a: 1 } });
    rewriteLine(ledger, 0, (event) => {
      event.payload = { a: 2 };
    });
    expect(() => ledger.append({ actor: "omf", type: "project.touched", payload: {} })).toThrow(LedgerCorruptError);
  });

  it("rejects an invalid event without writing it", () => {
    const ledger = newLedger();
    expect(() => ledger.append({ actor: "robot", type: "project.initialized", payload: {} })).toThrow(/invalid event/);
    expect(ledger.verify()).toEqual({ ok: true, count: 0, head: GENESIS_HASH });
  });

  it("readVerified throws on a corrupt ledger", () => {
    const ledger = newLedger();
    ledger.append({ actor: "omf", type: "project.initialized", payload: { a: 1 } });
    rewriteLine(ledger, 0, (event) => {
      event.actor = "human:mallory";
    });
    expect(() => ledger.readVerified()).toThrow(LedgerCorruptError);
  });
});
