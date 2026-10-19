// K05: host state never lives in the repository. An OMF_HOME inside the repo, or a relative one, is refused (exit 2)
// before anything is created (spec 5.0).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createWorld, snapshot } from "../lib/harness.mjs";

describe("K05 state never lives in the repository", () => {
  const world = createWorld();
  after(() => world.cleanup());

  it("refuses an OMF_HOME inside the repository and creates nothing", () => {
    const before = snapshot(world.repo, [".git"]);
    const inside = join(world.repo, ".omf");
    const result = world.omf(["init"], { env: { OMF_HOME: inside } });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /must live outside the repository/);
    assert.equal(existsSync(inside), false);
    assert.deepEqual(snapshot(world.repo, [".git"]), before);
  });

  it("refuses a relative OMF_HOME", () => {
    const result = world.omf(["init"], { env: { OMF_HOME: "relative/state" } });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /OMF_HOME must be an absolute path/);
    assert.equal(existsSync(join(world.repo, "relative")), false);
  });
});
