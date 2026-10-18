// K06: a work item the ledger does not know is refused by every verb that takes one: exit 2, the id is named, and
// nothing is appended to the ledger.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createWorld, must } from "../lib/harness.mjs";

const UNKNOWN = "w-ffffffffffff";

describe("K06 unknown item refused", () => {
  const world = createWorld();
  before(() => {
    must("init", world.omf(["init"]));
  });
  after(() => world.cleanup());

  for (const verb of ["seal", "run", "report"]) {
    it(`omf ${verb} names the unknown item`, () => {
      const ledger = world.ledgerBytes();
      const result = world.omf([verb, UNKNOWN]);
      assert.equal(result.code, 2, result.stdout + result.stderr);
      assert.ok((result.stdout + result.stderr).includes(UNKNOWN));
      assert.ok(world.ledgerBytes().equals(ledger), "the ledger changed");
    });
  }

  it("omf decide show names the unknown item", () => {
    const result = world.omf(["decide", "show", UNKNOWN]);
    assert.equal(result.code, 2);
    assert.ok(result.stderr.includes(UNKNOWN));
  });
});
