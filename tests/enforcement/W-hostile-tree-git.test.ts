import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { gitEnv } from "../../src/core/paths.js";
import { createScratchGitDir, type GitTarget } from "../../src/git/hardened.js";
import * as ops from "../../src/git/ops.js";
import { makeEmptyQuarantine, put, realTempDir } from "../helpers/ops-fixture.js";
import { commitAll, gitIn } from "../helpers/tmp.js";

const CANARY = "omf-vault-canary-7c1e9d42b8a05f36";

/** Names of the ops functions that ran against the hostile material, compared with the module's exports below. */
const exercised = new Set<string>();
function call<T>(name: keyof typeof ops, run: () => Promise<T>): Promise<T> {
  exercised.add(name);
  return run();
}

interface World {
  sentinels: string;
  fakeVault: string;
  tree: string;
  home: string;
  quarantine: GitTarget;
  head: string;
  seen: string[];
  applied: boolean;
  escaped: boolean;
  clean: boolean;
}
let w: World;
const sentinelCount = (): number => readdirSync(w.sentinels).length;

// Spec §5.4, §7 (M3-D15): everything a container wrote is hostile on the host.
describe("W-hostile-tree-git", () => {
  beforeAll(async () => {
    const root = realTempDir("omf-hostile-");
    const sentinels = join(root, "sentinels");
    mkdirSync(sentinels);
    // Every script that git could be tricked into running writes a file here: an executed trap is a visible file.
    const trap = join(root, "trap.sh");
    writeFileSync(trap, `#!/bin/sh\necho ran >> "${sentinels}/ran-$$"\nexit 0\n`);
    chmodSync(trap, 0o755);
    const hooks = join(root, "hooks");
    mkdirSync(hooks);
    for (const name of ["pre-commit", "post-checkout", "post-merge", "pre-push"]) {
      copyFileSync(trap, join(hooks, name));
      chmodSync(join(hooks, name), 0o755);
    }
    const setConfig = (configFile: string, entries: Record<string, string>): void => {
      for (const [key, value] of Object.entries(entries)) gitIn(root, "config", "--file", configFile, key, value);
    };
    const traps = { "core.fsmonitor": trap, "core.hooksPath": hooks };

    // The fake vault, and the history that the candidate "wrote": a filter attribute and a symlink to the vault.
    const fakeVault = join(root, "vault");
    put(fakeVault, "secret.txt", `${CANARY}\n`);
    const work = join(root, "work");
    mkdirSync(work);
    gitIn(work, "init", "-q", "-b", "main");
    put(work, ".gitattributes", "* filter=evil\n*.ts diff=evil\n");
    put(work, "src/a.ts", "export const a = 1;\n");
    commitAll(work, "base");
    const base = gitIn(work, "rev-parse", "HEAD").trim();
    put(work, "src/a.ts", "export const a = 2;\n");
    symlinkSync(fakeVault, join(work, "vault"));
    commitAll(work, "head: hostile tree");
    const head = gitIn(work, "rev-parse", "HEAD").trim();

    // It arrives as a bundle into a quarantine repository whose own config is poisoned the same way.
    const bundle = join(root, "hostile.bundle");
    gitIn(work, "bundle", "create", bundle, "main");
    const quarantine = makeEmptyQuarantine();
    setConfig(join(quarantine.gitDir, "config"), traps);
    expect(await call("bundleVerify", () => ops.bundleVerify(quarantine, bundle))).toBe(true);
    await call("unbundle", () => ops.unbundle(quarantine, bundle));
    expect(await call("fsckStrict", () => ops.fsckStrict(quarantine))).toBe(true);

    const seen: string[] = [];
    expect(await call("resolveCommit", () => ops.resolveCommit(quarantine, head))).toBe(head);
    seen.push(String(await call("isAncestor", () => ops.isAncestor(quarantine, base, head))));
    seen.push(JSON.stringify(await call("rawDiff", () => ops.rawDiff(quarantine, base, head))));
    const patch = await call("revertPatch", () => ops.revertPatch(quarantine, base, head, ["src/a.ts"]));
    seen.push(patch);
    seen.push((await call("unifiedDiff", () => ops.unifiedDiff(quarantine, base, head))).toString("latin1"));
    seen.push(await call("commitMessages", () => ops.commitMessages(quarantine, base, head)));
    seen.push((await call("treePaths", () => ops.treePaths(quarantine, head))).join("\n"));
    const tarFile = join(root, "head.tar");
    await call("archiveTar", () => ops.archiveTar(quarantine, head, tarFile));
    seen.push(spawnSync("tar", ["-tf", tarFile], { encoding: "utf8" }).stdout);

    // The container-written tree: the exported files, then what a hostile container adds on top.
    const tree = join(root, "tree");
    mkdirSync(tree);
    await call("exportTree", () => ops.exportTree(quarantine, head, tree));
    const evil = join(root, "evil");
    mkdirSync(evil);
    gitIn(evil, "init", "-q");
    setConfig(join(evil, ".git", "config"), { ...traps, "filter.evil.clean": trap, "filter.evil.smudge": trap, "diff.evil.textconv": trap });
    writeFileSync(join(tree, ".git"), `gitdir: ${join(evil, ".git")}\n`);
    const nested = join(tree, "nested");
    mkdirSync(nested);
    gitIn(nested, "init", "-q");
    setConfig(join(nested, ".git", "config"), traps);
    copyFileSync(trap, join(nested, ".git", "hooks", "pre-commit"));
    chmodSync(join(nested, ".git", "hooks", "pre-commit"), 0o755);

    const clean = await call("isDirClean", () => ops.isDirClean({ ...quarantine, indexFile: join(root, "index") }, head, tree));
    mkdirSync(join(root, "scratch-parent"));
    const scratch = await createScratchGitDir(join(root, "scratch-parent"));
    const applied = await call("applyPatchToDir", () => ops.applyPatchToDir(scratch, tree, patch, { reverse: true }));
    const escapePatch = [
      "diff --git a/vault/secret.txt b/vault/secret.txt", "--- a/vault/secret.txt", "+++ b/vault/secret.txt", "@@ -1 +1 @@", `-${CANARY}`, "+overwritten", "",
    ].join("\n");
    const escaped = await call("applyPatchToDir", () => ops.applyPatchToDir(scratch, tree, escapePatch, { reverse: false }));

    w = { sentinels, fakeVault, tree, home: realTempDir("omf-home-"), quarantine, head, seen, applied, escaped, clean };
  });

  it("every exported function of the module ran against the hostile material", () => {
    expect([...exercised].sort()).toEqual(Object.keys(ops).sort());
  });

  it("no hook, fsmonitor, filter or textconv script ran", () => {
    expect(readdirSync(w.sentinels)).toEqual([]);
  });

  it("nothing was read from or written through the vault symlink", () => {
    expect(w.seen.join("\n")).not.toContain(CANARY);
    expect(readFileSync(join(w.fakeVault, "secret.txt"), "utf8")).toBe(`${CANARY}\n`);
    expect(readdirSync(w.fakeVault)).toEqual(["secret.txt"]);
    expect(lstatSync(join(w.tree, "vault")).isSymbolicLink()).toBe(true);
    expect(w.escaped).toBe(false); // a patch that edits a file beyond the link is refused
    expect(w.applied).toBe(true); // an honest patch still applies in the same tree
    expect(w.clean).toBe(false); // the planted nested repository and root .git are not part of the tree
  });

  // Positive controls: the traps are live, so the zero above is the module's doing and not an inert fixture.
  it("control: bare git status in the same tree runs the planted fsmonitor", () => {
    const before = sentinelCount();
    spawnSync("git", ["status"], { cwd: w.tree, env: { ...gitEnv(), HOME: w.home, GIT_CONFIG_NOSYSTEM: "1" }, stdio: "ignore" });
    expect(sentinelCount()).toBeGreaterThan(before);
  });

  it("control: update-index without the hardened prefix runs the quarantine's poisoned fsmonitor", () => {
    const before = sentinelCount();
    const env = { ...gitEnv(), HOME: w.home, GIT_CONFIG_NOSYSTEM: "1", GIT_INDEX_FILE: join(realTempDir("omf-control-"), "index") };
    const run = (...args: string[]): void => {
      spawnSync("git", [`--git-dir=${w.quarantine.gitDir}`, `--work-tree=${w.tree}`, ...args], { cwd: w.tree, env, stdio: "ignore" });
    };
    run("read-tree", w.head);
    run("update-index", "-q", "--refresh");
    expect(sentinelCount()).toBeGreaterThan(before);
  });

  // filter, textconv and diff.external are not neutralised by the hardened prefix: they are closed by refusing a repository whose own config defines one.
  it("a quarantine whose config defines a filter, a textconv or diff.external is refused by every ops call, and no driver runs", async () => {
    const root = realTempDir("omf-driver-");
    const sentinels = join(root, "sentinels");
    mkdirSync(sentinels);
    const trap = join(root, "trap.sh");
    writeFileSync(trap, `#!/bin/sh\necho ran >> "${sentinels}/ran-$$"\ncat\n`);
    chmodSync(trap, 0o755);
    const driverKeys = ["filter.evil.clean", "filter.evil.smudge", "diff.evil.textconv", "diff.external"];
    for (const key of driverKeys) {
      const q = makeEmptyQuarantine();
      gitIn(q.gitDir, "config", key, trap);
      await expect(ops.resolveCommit(q, w.head)).rejects.toMatchObject({ code: "gitdir_invalid" });
      await expect(ops.archiveTar(q, w.head, join(root, `${key}.tar`))).rejects.toMatchObject({ code: "gitdir_invalid" });
      mkdirSync(join(root, `export-${key}`));
      await expect(ops.exportTree(q, w.head, join(root, `export-${key}`))).rejects.toMatchObject({ code: "gitdir_invalid" });
      await expect(ops.isDirClean({ ...q, indexFile: join(root, `index-${key}`) }, w.head, w.tree)).rejects.toMatchObject({ code: "gitdir_invalid" });
    }
    expect(readdirSync(sentinels)).toEqual([]);
  });

  it("control: the same driver config is live when git is run without the refusal (bare checkout-index and archive)", () => {
    const root = realTempDir("omf-driver-ctl-");
    const sentinels = join(root, "sentinels");
    mkdirSync(sentinels);
    const trap = join(root, "trap.sh");
    writeFileSync(trap, `#!/bin/sh\necho ran >> "${sentinels}/ran-$$"\ncat\n`);
    chmodSync(trap, 0o755);
    const repo = join(root, "r");
    mkdirSync(repo);
    gitIn(repo, "init", "-q");
    put(repo, ".gitattributes", "* filter=evil\n*.ts diff=evil\n");
    put(repo, "a.ts", "1\n");
    commitAll(repo, "one");
    gitIn(repo, "config", "filter.evil.smudge", trap);
    gitIn(repo, "config", "filter.evil.clean", trap);
    gitIn(repo, "config", "diff.evil.textconv", trap);
    const env = { ...gitEnv(), HOME: w.home, GIT_CONFIG_NOSYSTEM: "1" };
    spawnSync("git", ["archive", "-o", join(root, "o.tar"), "HEAD"], { cwd: repo, env, stdio: "ignore" });
    const afterArchive = sentinelCount2(sentinels);
    expect(afterArchive).toBeGreaterThan(0);
    put(repo, "a.ts", "2\n");
    spawnSync("git", ["diff", "HEAD"], { cwd: repo, env, stdio: "ignore" });
    expect(sentinelCount2(sentinels)).toBeGreaterThan(afterArchive);
  });
});

const sentinelCount2 = (dir: string): number => readdirSync(dir).length;
