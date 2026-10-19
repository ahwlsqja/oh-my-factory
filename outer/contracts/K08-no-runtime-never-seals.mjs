// K08: with no container runtime, `omf seal` never seals. The docker on PATH answers like a stopped daemon, the
// configuration is complete and the key is present, so the only thing missing is a daemon: the command exits 2,
// the ledger gets no seal event and the vault holds no scenario file (spec 5.3: the author runs only in a measured
// container).
import assert from "node:assert/strict";
import { appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createWorld, prepareItem, ttySkip } from "../lib/harness.mjs";

const IMAGE_ID = `sha256:${"0".repeat(64)}`;

describe("K08 no runtime never seals", { skip: ttySkip() }, () => {
  const world = createWorld();
  let workId;
  before(() => {
    workId = prepareItem(world, { resolve: true });
    appendFileSync(
      join(world.projectDir(), "config.toml"),
      `\n[judge]\ndocker_context = "omf-outer"\n\n[author]\nimage = "${IMAGE_ID}"\n`,
    );
  });
  after(() => world.cleanup());

  it("exits 2 and records nothing", () => {
    const events = world.events().length;
    const result = world.omf(["seal", workId], { env: { OMF_AUTHOR_API_KEY: "outer-suite-dummy-key" } });
    assert.equal(result.code, 2, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /docker/i);
    assert.equal(world.events().length, events, "the refused seal appended an event");
    assert.deepEqual(
      world.events().filter((event) => event.type.startsWith("seal.")),
      [],
    );
  });

  it("leaves no scenario in the vault", () => {
    const files = readdirSync(join(world.projectDir(), "vault", "scenarios"), { recursive: true });
    assert.deepEqual(files, []);
  });

  it("never prints the key", () => {
    const result = world.omf(["seal", workId], { env: { OMF_AUTHOR_API_KEY: "outer-suite-dummy-key" } });
    assert.ok(!(result.stdout + result.stderr).includes("outer-suite-dummy-key"));
  });
});
