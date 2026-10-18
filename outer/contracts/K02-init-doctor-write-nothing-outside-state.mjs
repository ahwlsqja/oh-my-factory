// K02: init, doctor and the read commands write only OMF host state. The repository (apart from .git), the home
// directory, ~/.claude, ~/.claude.json and ~/.codex stay as they were (spec 5.0: nothing is written into a repo or
// an agent's configuration).
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createWorld, must, snapshot } from "../lib/harness.mjs";

describe("K02 init and doctor write nothing outside host state", () => {
  const world = createWorld();
  after(() => world.cleanup());

  it("leaves the repository and the home directory untouched", () => {
    const repoBefore = snapshot(world.repo, [".git"]);
    must("init", world.omf(["init"]));
    world.omf(["doctor"]);
    must("ledger verify", world.omf(["ledger", "verify"]));
    must("goal new", world.omf(["goal", "new", "g-outer"]));
    assert.deepEqual(snapshot(world.repo, [".git"]), repoBefore);
    assert.equal(world.git("status", "--porcelain").stdout, "");
    assert.deepEqual(readdirSync(world.home), [], "something was written into HOME");
    for (const name of [".claude", ".claude.json", ".codex"]) {
      assert.equal(existsSync(join(world.home, name)), false, `${name} was created`);
    }
  });

  it("keeps state under OMF_HOME", () => {
    assert.ok(existsSync(join(world.projectDir(), "ledger.jsonl")));
  });
});
