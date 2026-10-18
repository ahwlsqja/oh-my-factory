// K07: the verbs refuse to run out of order and name the gate that is missing. GATE-1 open (a person owes J2) is
// exit 3; a missing seal (GATE-2) and a missing run (S7) are exit 2. A refusal writes nothing. After the person
// resolves the decision, GATE-1 is no longer what stops `omf seal`.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { answerFile, createWorld, must, prepareItem, ttySkip } from "../lib/harness.mjs";

describe("K07 out-of-order refusals", { skip: ttySkip() }, () => {
  const world = createWorld();
  let workId;
  before(() => {
    workId = prepareItem(world, { resolve: false });
  });
  after(() => world.cleanup());

  const refuses = (args, code, pattern) => {
    const ledger = world.ledgerBytes();
    const result = world.omf(args);
    assert.equal(result.code, code, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, pattern);
    assert.ok(world.ledgerBytes().equals(ledger), "a refusal changed the ledger");
  };

  it("seal with GATE-1 open: exit 3, GATE-1 named", () => {
    refuses(["seal", workId], 3, /GATE-1/);
  });

  it("run with GATE-1 open: exit 3, GATE-1 named", () => {
    refuses(["run", workId], 3, /GATE-1/);
  });

  it("run before any seal: exit 2, GATE-2 named with the verb to run", () => {
    must(
      "resolve",
      world.tty(`${workId}/d-interface`, [
        "decide",
        "resolve",
        workId,
        "d-interface",
        "--file",
        answerFile("resolve.json"),
      ]),
    );
    refuses(["run", workId], 2, /GATE-2[\s\S]*omf seal/);
  });

  it("report before any run: exit 2, S7 named with the verb to run", () => {
    refuses(["report", workId], 2, /S7[\s\S]*omf run/);
  });
});
