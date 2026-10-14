import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/core/canonical-json.js";
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
    const second = ledger.append({ actor: "human:dev", type: "budget.declared", payload: { goal_id: "g-x", kind: "rounds", amount: 3 } });
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

  it("inspect returns the verification result and the events it covered", () => {
    const ledger = newLedger();
    ledger.append({ actor: "omf", type: "project.initialized", payload: {} });
    ledger.append({ actor: "omf", type: "project.touched", payload: {} });
    const { result, events } = ledger.inspect();
    expect(result).toEqual(ledger.verify());
    expect(result).toMatchObject({ ok: true, count: 2 });
    expect(events).toEqual(ledger.readVerified());
    expect(events).toHaveLength(2);
  });

  it("inspect returns no events when the chain is broken", () => {
    const ledger = newLedger();
    ledger.append({ actor: "omf", type: "project.initialized", payload: { a: 1 } });
    rewriteLine(ledger, 0, (event) => {
      event.payload = { a: 2 };
    });
    const { result, events } = ledger.inspect();
    expect(result).toEqual({ ok: false, seq: 1, reason: "hash mismatch" });
    expect(events).toEqual([]);
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

  it("treats a BOM-prefixed unterminated final line as torn", () => {
    const ledger = newLedger();
    ledger.append({ actor: "omf", type: "project.initialized", payload: {} });
    const second = ledger.append({ actor: "omf", type: "project.touched", payload: {} });
    ledger.append({ actor: "omf", type: "project.touched", payload: { third: true } });
    // A genuine, valid third event, written as BOM + JSON with its newline removed.
    const [kept1, kept2, third] = readFileSync(ledger.file, "utf8").trimEnd().split("\n");
    writeFileSync(ledger.file, `${kept1}\n${kept2}\n﻿${third}`);
    expect(ledger.verify()).toEqual({ ok: true, count: 2, head: second.hash, tornTail: true });
  });

  it("treats a file that is only a torn tail (no newline at all) as zero events", () => {
    const ledger = newLedger();
    writeFileSync(ledger.file, '{"schema_version":1,"se');
    expect(ledger.verify()).toEqual({ ok: true, count: 0, head: GENESIS_HASH, tornTail: true });
    ledger.append({ actor: "omf", type: "project.touched", payload: {} });
    const events = ledger.readVerified();
    expect(events.map((e) => [e.seq, e.type])).toEqual([
      [1, "ledger.tail_discarded"],
      [2, "project.touched"],
    ]);
    expect(ledger.verify()).toMatchObject({ ok: true, count: 2 });
  });

  it("treats a valid-UTF-8 non-object tail with no newline as torn", () => {
    const ledger = newLedger();
    const first = ledger.append({ actor: "omf", type: "project.initialized", payload: {} });
    appendFileSync(ledger.file, "123");
    expect(ledger.verify()).toEqual({ ok: true, count: 1, head: first.hash, tornTail: true });
  });

  it("records a torn tail that splits a multibyte character by its raw bytes", () => {
    const ledger = newLedger();
    ledger.append({ actor: "omf", type: "project.initialized", payload: {} });
    const torn = Buffer.concat([Buffer.from('{"x":"a'), Buffer.from("가").subarray(0, 2)]);
    appendFileSync(ledger.file, torn);
    ledger.append({ actor: "omf", type: "project.touched", payload: {} });
    const discarded = ledger.readVerified().find((event) => event.type === "ledger.tail_discarded");
    expect(discarded?.payload).toEqual({ bytes: torn.length, sha256: sha256Hex(torn) });
    expect(readFileSync(ledger.file).includes(torn)).toBe(false);
    expect(ledger.verify()).toMatchObject({ ok: true, count: 3 });
  });

  it("leaves a torn tail untouched when the next append is rejected", () => {
    const ledger = newLedger();
    ledger.append({ actor: "omf", type: "project.initialized", payload: {} });
    appendFileSync(ledger.file, '{"schema_version":1,"seq":2,"pre');
    const before = readFileSync(ledger.file);
    expect(() => ledger.append({ actor: "robot", type: "project.touched", payload: {} })).toThrow(/invalid event/);
    expect(readFileSync(ledger.file)).toEqual(before);
  });

  it("leaves a missing newline untouched when the next append is rejected", () => {
    const ledger = newLedger();
    ledger.append({ actor: "omf", type: "project.initialized", payload: {} });
    writeFileSync(ledger.file, readFileSync(ledger.file, "utf8").trimEnd());
    const before = readFileSync(ledger.file);
    expect(() => ledger.append({ actor: "robot", type: "project.touched", payload: {} })).toThrow(/invalid event/);
    expect(readFileSync(ledger.file)).toEqual(before);
  });

  it("reports a blank line between events as corruption", () => {
    const ledger = newLedger();
    ledger.append({ actor: "omf", type: "project.initialized", payload: {} });
    ledger.append({ actor: "omf", type: "project.touched", payload: {} });
    const [first, second] = readFileSync(ledger.file, "utf8").trimEnd().split("\n");
    writeFileSync(ledger.file, `${first}\n\n${second}\n`);
    expect(ledger.verify()).toEqual({ ok: false, seq: 2, reason: "empty line" });
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
    expect(ledger.readVerified().map((event) => event.payload)).toEqual([{ seen: 0 }, { seen: 1 }]);
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

describe("appendWithMany", () => {
  it("appends several events from one locked read, chained in order", () => {
    const ledger = newLedger();
    ledger.append({ actor: "omf", type: "project.initialized", payload: {} });
    let seen = -1;
    const written = ledger.appendWithMany((events) => {
      seen = events.length;
      return [
        { actor: "omf", type: "test.first", payload: { n: 1 } },
        { actor: "omf", type: "test.second", payload: { n: 2 } },
        { actor: "omf", type: "test.third", payload: { n: 3 } },
      ];
    });
    expect(seen).toBe(1);
    expect(written.map((e) => [e.seq, e.type])).toEqual([
      [2, "test.first"],
      [3, "test.second"],
      [4, "test.third"],
    ]);
    expect(ledger.verify()).toMatchObject({ ok: true, count: 4, head: written[2]?.hash });
  });

  it("writes nothing when build throws or returns no event", () => {
    const ledger = newLedger();
    ledger.append({ actor: "omf", type: "project.initialized", payload: {} });
    expect(() =>
      ledger.appendWithMany(() => {
        throw new Error("precondition failed");
      }),
    ).toThrow("precondition failed");
    expect(() => ledger.appendWithMany(() => [])).toThrow(/at least one event/);
    expect(ledger.verify()).toMatchObject({ ok: true, count: 1 });
  });

  it("writes nothing when a later event is invalid", () => {
    const ledger = newLedger();
    expect(() =>
      ledger.appendWithMany(() => [
        { actor: "omf", type: "test.ok", payload: {} },
        { actor: "robot", type: "test.bad", payload: {} },
      ]),
    ).toThrow(/invalid event/);
    expect(ledger.verify()).toMatchObject({ ok: true, count: 0 });
  });

  it("discards a torn tail once and returns only the requested events", () => {
    const ledger = newLedger();
    ledger.append({ actor: "omf", type: "project.initialized", payload: {} });
    appendFileSync(ledger.file, '{"schema_version":1,"seq":2,"pre');
    const written = ledger.appendWithMany(() => [
      { actor: "omf", type: "test.a", payload: {} },
      { actor: "omf", type: "test.b", payload: {} },
    ]);
    expect(written.map((e) => e.type)).toEqual(["test.a", "test.b"]);
    expect(ledger.readVerified().map((e) => e.type)).toEqual([
      "project.initialized",
      "ledger.tail_discarded",
      "test.a",
      "test.b",
    ]);
  });
});
