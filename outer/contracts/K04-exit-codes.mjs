// K04: the documented exit codes. 0 ok, 1 a problem was found or the usage is wrong, 2 the command could not run
// (outside a git repository, a corrupt ledger), 3 blocked on a person (asserted in K07). Scripts and agents branch on
// these numbers, so they cannot drift.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createWorld, must, tamperLedger } from "../lib/harness.mjs";

describe("K04 exit codes", () => {
  const world = createWorld();
  after(() => world.cleanup());

  it("--help and --version exit 0", () => {
    assert.equal(world.omf(["--help"]).code, 0);
    assert.match(must("--version", world.omf(["--version"])).stdout, /^\d+\.\d+\.\d+/);
  });

  it("an unknown verb exits 1", () => {
    const result = world.omf(["no-such-verb"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown command/);
  });

  it("outside a git repository the command could not run: exit 2", () => {
    const result = world.omf(["ledger", "verify"], { cwd: world.root });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /not a git repository/);
  });

  it("a repository that was never initialized could not run: exit 2", () => {
    assert.equal(world.omf(["ledger", "verify"]).code, 2);
  });

  it("a corrupt ledger: verify finds it (1), the others refuse (2)", () => {
    must("init", world.omf(["init"]));
    tamperLedger(world, 1);
    assert.equal(world.omf(["ledger", "verify"]).code, 1);
    assert.equal(world.omf(["work", "list", "g-outer"]).code, 2);
  });
});
