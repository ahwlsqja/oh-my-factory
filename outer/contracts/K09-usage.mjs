// K09: the verbs a person or an agent is told to use exist and print their own usage. Removing or renaming one is a
// breaking change that has to edit this contract in a kernel-path pull request.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createWorld } from "../lib/harness.mjs";

describe("K09 usage", () => {
  const world = createWorld();
  after(() => world.cleanup());

  const verbs = ["init", "doctor", "ledger", "goal", "work", "budget", "decide", "seal", "run", "report"];

  it("--help lists every verb and the exit codes", () => {
    const result = world.omf(["--help"]);
    assert.equal(result.code, 0);
    for (const verb of verbs) assert.match(result.stdout, new RegExp(`^  ${verb}\\b`, "m"), `${verb} is not listed`);
    assert.match(result.stdout, /Exit codes: 0 ok, 1 /);
  });

  for (const verb of ["seal", "run", "report"]) {
    it(`omf ${verb} --help takes a work id`, () => {
      const result = world.omf([verb, "--help"]);
      assert.equal(result.code, 0);
      assert.match(result.stdout, /<work_id>/);
    });
  }
});
