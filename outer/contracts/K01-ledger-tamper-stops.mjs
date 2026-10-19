// K01: a ledger that was edited by one byte stops everything. `ledger verify` and `doctor` report it (exit 1, they
// are the commands whose job is to find problems); every other command that reads the ledger refuses to run (exit 2)
// and none of them changes the ledger file (kernel promise: the hash chain is the record, spec 4.2).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createWorld, GOAL, prepareItem, tamperLedger, ttySkip } from "../lib/harness.mjs";

describe("K01 ledger tamper stops", { skip: ttySkip() }, () => {
  const world = createWorld();
  let workId;
  let tampered;
  before(() => {
    workId = prepareItem(world, { resolve: false });
    tampered = tamperLedger(world);
  });
  after(() => world.cleanup());

  it("ledger verify finds the edit and names the event", () => {
    const result = world.omf(["ledger", "verify"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /corrupt at seq 3: hash mismatch/);
  });

  it("doctor reports the edit as a problem", () => {
    const result = world.omf(["doctor"]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /ledger corrupt at seq 3/);
  });

  for (const verb of [
    ["work", "list", GOAL],
    ["goal", "status", GOAL],
    ["goal", "audit", GOAL],
    ["budget", "show", GOAL],
    ["decide", "show", "<item>"],
    ["seal", "<item>"],
    ["run", "<item>"],
    ["report", "<item>"],
  ]) {
    it(`omf ${verb.join(" ")} refuses to read it`, () => {
      const args = verb.map((word) => (word === "<item>" ? workId : word));
      const result = world.omf(args);
      assert.equal(result.code, 2, result.stdout + result.stderr);
      assert.match(result.stderr, /corrupt/);
    });
  }

  it("no command changed the ledger file", () => {
    assert.ok(world.ledgerBytes().equals(tampered), "the ledger bytes differ from the tampered bytes");
  });
});
