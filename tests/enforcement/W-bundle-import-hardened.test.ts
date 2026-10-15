import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as ops from "../../src/git/ops.js";
import { attemptImport, importCode } from "../helpers/candidate-import.js";
import { type CandidateWorld, bundleOf, gitAs, makeCandidateWorld } from "../helpers/git-fixture.js";
import { makeBundles, makeOpsFixture, put, realTempDir, type BundleFixture } from "../helpers/ops-fixture.js";
import { gitIn } from "../helpers/tmp.js";

const CANARY = "omf-vault-canary-7c1e9d42b8a05f36";

/** A config entry and four hooks that write a sentinel file when git runs them: an executed trap is a visible file. */
function plant(repo: string, trap: string): void {
  gitIn(repo, "config", "core.fsmonitor", trap);
  for (const name of ["pre-commit", "post-checkout", "post-merge", "reference-transaction"]) {
    const hook = join(repo, ".git", "hooks", name);
    copyFileSync(trap, hook);
    chmodSync(hook, 0o755);
  }
}

let sentinels: string;
let world: CandidateWorld;
let hostile: Awaited<ReturnType<typeof attemptImport>>;
let refShapes: Array<[string, Buffer]>;
let broken: BundleFixture;

// Spec §5.4, §7: a bundle a container wrote is hostile data. Only its objects are read, in a quarantine OMF created.
describe("W-bundle-import-hardened", () => {
  beforeAll(async () => {
    const root = realTempDir("omf-bundle-hostile-");
    sentinels = join(root, "sentinels");
    mkdirSync(sentinels);
    const trap = join(root, "trap.sh");
    writeFileSync(trap, `#!/bin/sh\necho ran >> "${sentinels}/ran-$$"\nexit 0\n`);
    chmodSync(trap, 0o755);
    const vault = join(root, "vault");
    put(vault, "secret.txt", `${CANARY}\n`);

    world = makeCandidateWorld({ workId: "w1" });
    const repo = world.containerRepo;
    // The hostile commit: attributes naming a filter, a submodule file, a hook-looking file, a symlink to the vault and a gitlink.
    put(repo, ".gitattributes", "* filter=evil\n*.ts diff=evil\n");
    put(repo, ".gitmodules", '[submodule "sub"]\n\tpath = vendor/sub\n\turl = https://example.invalid/sub.git\n');
    put(repo, "tools/pre-commit", "#!/bin/sh\necho ran\n");
    chmodSync(join(repo, "tools", "pre-commit"), 0o755);
    symlinkSync(vault, join(repo, "vault-link"));
    gitAs(repo, "add", "-A");
    gitAs(repo, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},vendor/sub`);
    gitAs(repo, "commit", "-q", "-m", "hostile");
    gitAs(repo, "tag", "v1");
    gitAs(repo, "branch", "extra");
    // Every bundle is made before the traps go in, so building them cannot run one.
    const hostileBundle = bundleOf(repo);
    refShapes = [
      ["a branch and no HEAD", bundleOf(repo, "main")],
      ["HEAD and a branch", bundleOf(repo, "HEAD", "main")],
      ["HEAD and a tag", bundleOf(repo, "HEAD", "v1")],
      ["HEAD and a second head", bundleOf(repo, "HEAD", "refs/heads/extra")],
    ];
    plant(repo, trap);
    plant(world.userRepo, trap);

    broken = makeBundles(makeOpsFixture());
    hostile = await attemptImport(world, { bundle: hostileBundle });
  });

  it("imports the hostile commit as data: nothing ran, the vault was not read, and the odd entries are only names", async () => {
    expect(importCode(hostile.result)).toBe("ok");
    expect(readdirSync(sentinels)).toEqual([]);
    if (!hostile.result.ok) return;
    const { quarantine, head } = hostile.result.value;
    expect(await ops.treePaths(quarantine, head)).toEqual(
      expect.arrayContaining(["vault-link", "vendor/sub", ".gitattributes", ".gitmodules", "tools/pre-commit"]),
    );
    const objects = await ops.reachableObjects(quarantine, head, 10_000);
    const shas = objects.map((object) => object.sha);
    for await (const object of ops.readObjectsBatch(quarantine, shas, 1024 * 1024)) {
      expect(object.bytes.includes(Buffer.from(CANARY))).toBe(false);
    }
  });

  it("decides nothing by ref names: only a bundle whose single ref is HEAD is accepted", async () => {
    for (const [shape, bundle] of refShapes) {
      const { result } = await attemptImport(world, { bundle });
      expect([shape, importCode(result)]).toEqual([shape, "head_missing"]);
    }
  });

  it("answers a junk file, a truncated pack and an object that fails fsck with a closed code and leaves nothing behind", async () => {
    const cases: Array<[string, string, string[]]> = [
      ["junk", broken.junk, ["bundle_invalid"]],
      ["truncated", broken.truncated, ["bundle_invalid"]],
      // Git 2.53 imports the bad tree and `fsck --strict` rejects it; a git whose `unbundle` rejects it first answers bundle_invalid.
      ["fsck", broken.bad, ["fsck_failed", "bundle_invalid"]],
    ];
    for (const [name, file, accepted] of cases) {
      const { result, stageDir } = await attemptImport(world, { bundle: readFileSync(file) });
      expect(accepted, name).toContain(importCode(result));
      expect(readdirSync(stageDir), name).toEqual([]);
    }
  });
});
