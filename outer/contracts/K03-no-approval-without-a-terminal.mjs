// K03: a person's decision (J1 goal approval, J2 decisions, J8 budgets, J6 resume and cancel, high-risk work approval)
// is never taken without an interactive terminal. With stdin and stdout piped each command refuses (exit 2) and
// says so, and the ledger does not change (spec 6.2: no silent approval).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { answerFile, createWorld, GOAL, prepareItem, ttySkip } from "../lib/harness.mjs";

describe("K03 no approval without a terminal", { skip: ttySkip() }, () => {
  const world = createWorld();
  let workId;
  before(() => {
    workId = prepareItem(world, { resolve: false });
  });
  after(() => world.cleanup());

  const refusals = (id) => [
    ["goal", "approve", GOAL],
    ["work", "approve", id],
    ["decide", "resolve", id, "d-interface", "--file", answerFile("resolve.json")],
    ["decide", "resolve", id, "d-interface", "--na", "--file", answerFile("na.json")],
    ["decide", "defer", id, "d-interface", "--file", answerFile("defer.json")],
    ["budget", "declare", GOAL, "rounds", "5"],
    ["budget", "raise", GOAL, "rounds", "20"],
    ["goal", "resume", GOAL],
    ["goal", "cancel", GOAL],
  ];

  for (const index of refusals("<item>").keys()) {
    it(`refuses command ${index + 1} without a terminal and writes nothing`, () => {
      const args = refusals(workId)[index];
      const before = world.ledgerBytes();
      const result = world.omf(args);
      assert.notEqual(result.code, 0, `omf ${args.join(" ")} succeeded without a terminal`);
      assert.match(result.stderr, /needs an interactive terminal/);
      assert.ok(world.ledgerBytes().equals(before), "the ledger changed");
    });
  }
});
