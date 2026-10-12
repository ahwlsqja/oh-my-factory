import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
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
  it("reports a non-object line instead of throwing", () => {
    const ledger = newLedger();
    ledger.append({ actor: "omf", type: "project.initialized", payload: {} });
    appendFileSync(ledger.file, "null\n");
    expect(ledger.verify()).toEqual({ ok: false, seq: 2, reason: "not an object" });
  });

  it("ignores a torn final line and discards it on the next append", () => {
    const ledger = newLedger();
    const first = ledger.append({ actor: "omf", type: "project.initialized", payload: {} });
    const torn = '{"schema_version":1,"seq":2,"pre';
    appendFileSync(ledger.file, torn);
    expect(ledger.verify()).toEqual({ ok: true, count: 1, head: first.hash, tornTail: true });
    expect(ledger.readVerified()).toHaveLength(1);
    ledger.append({ actor: "omf", type: "project.touched", payload: {} });
    const events = ledger.readVerified();
    expect(events.map((e) => e.type)).toEqual(["project.initialized", "ledger.tail_discarded", "project.touched"]);
    expect(events[1]?.payload.bytes).toBe(Buffer.byteLength(torn));
    const last = events[events.length - 1];
    expect(ledger.verify()).toEqual({ ok: true, count: 3, head: last?.hash });
  });

  it("keeps an intact final event that lost its newline", () => {
    const ledger = newLedger();
    ledger.append({ actor: "omf", type: "project.initialized", payload: {} });
    writeFileSync(ledger.file, readFileSync(ledger.file, "utf8").trimEnd());
    const result = ledger.verify();
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ count: 1 });
    expect(result).not.toHaveProperty("tornTail");
    ledger.append({ actor: "omf", type: "project.touched", payload: {} });
    const after = ledger.verify();
    expect(after.ok).toBe(true);
    expect(after).toMatchObject({ count: 2 });
  });

  it("rejects a non-plain payload as an invalid event", () => {
    const ledger = newLedger();
    expect(() => ledger.append({ actor: "omf", type: "project.touched", payload: { at: new Date() } })).toThrow(/invalid event/);
    expect(ledger.verify()).toMatchObject({ ok: true, count: 0 });
  });

  it("detects an edited prev_hash", () => {
    const ledger = newLedger();
    ledger.append({ actor: "omf", type: "project.initialized", payload: {} });
    ledger.append({ actor: "omf", type: "project.touched", payload: {} });
    rewriteLine(ledger, 1, (event) => {
      event.prev_hash = "1".repeat(64);
    });
    expect(ledger.verify()).toEqual({ ok: false, seq: 2, reason: "prev_hash mismatch" });
  });

  it("known limit (spec §8): removing events from the end is not detected", () => {
    const ledger = newLedger();
    const first = ledger.append({ actor: "omf", type: "project.initialized", payload: {} });
    ledger.append({ actor: "omf", type: "project.touched", payload: {} });
    const lines = readFileSync(ledger.file, "utf8").trimEnd().split("\n");
    writeFileSync(ledger.file, `${lines[0]}\n`);
    expect(ledger.verify()).toEqual({ ok: true, count: 1, head: first.hash });
  });

  it("appendWith builds the event from the verified events", () => {
    const ledger = newLedger();
    const seen: number[] = [];
    ledger.appendWith((events) => {
      seen.push(events.length);
      return { actor: "omf", type: "project.touched", payload: { seen: events.length } };
    });
    ledger.appendWith((events) => {
      seen.push(events.length);
      return { actor: "omf", type: "project.touched", payload: { seen: events.length } };
    });
    expect(seen).toEqual([0, 1]);
    expect(ledger.readAll().map((event) => event.payload)).toEqual([{ seen: 0 }, { seen: 1 }]);
  });

  it("appendWith writes nothing when build throws", () => {
    const ledger = newLedger();
    expect(() =>
      ledger.appendWith(() => {
        throw new Error("no");
      }),
    ).toThrow(/^no$/);
    expect(ledger.verify()).toEqual({ ok: true, count: 0, head: GENESIS_HASH });
  });
});
