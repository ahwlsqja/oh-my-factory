import { lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { revertPatch } from "../../src/git/ops.js";
import { fixtureTarget } from "../helpers/fixture-target.js";
import { type OpsFixture, makeOpsFixture, realTempDir } from "../helpers/ops-fixture.js";
import { TempWorkCopyFactory, sweepOrphanCopies } from "../helpers/temp-work-copy.js";

let fx: OpsFixture;
beforeAll(() => {
  fx = makeOpsFixture();
});

const factoryIn = (parent = realTempDir("omf-copies-")) => ({ parent, factory: new TempWorkCopyFactory({ parent, exec: (root) => fixtureTarget(root) }) });
const spec = () => ({ quarantine: fx.quarantine, sha: fx.head });

describe("TempWorkCopyFactory", () => {
  it("refuses to construct without an exec, with a relative parent or inside an agent home", () => {
    const parent = realTempDir("omf-copies-");
    expect(() => new TempWorkCopyFactory({ parent } as never)).toThrow(/needs an exec/);
    expect(() => new TempWorkCopyFactory({ parent: "relative", exec: (root) => fixtureTarget(root) })).toThrow(/absolute/);
  });

  it("makes a private copy that equals the head tree", async () => {
    const { parent, factory } = factoryIn();
    const copy = await factory.create(spec());
    const root = join(parent, copy.id);
    expect(copy.id).toMatch(/^wc-\d+-[0-9a-f]{8}$/);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe("export const a = 2;\n");
    expect(lstatSync(join(root, "l.txt")).isSymbolicLink()).toBe(true);
    expect(await copy.isClean()).toBe(true);
    await copy.dispose();
  });

  it("isClean flips on an edit and on an untracked file, and a second copy is not affected", async () => {
    const { parent, factory } = factoryIn();
    const first = await factory.create(spec());
    const second = await factory.create(spec());
    expect(first.id).not.toBe(second.id);
    writeFileSync(join(parent, first.id, "src", "a.ts"), "edited\n");
    expect(await first.isClean()).toBe(false);
    expect(await second.isClean()).toBe(true);
    writeFileSync(join(parent, second.id, "untracked.txt"), "x\n");
    expect(await second.isClean()).toBe(false);
    await first.dispose();
    await second.dispose();
  });

  it("runs commands through the injected exec, in the copy", async () => {
    const { factory } = factoryIn();
    const copy = await factory.create(spec());
    const result = await copy.run([process.execPath, "-e", "process.stdout.write(require('fs').readFileSync('src/a.ts', 'utf8'))"], {
      timeoutMs: 20_000,
      maxOutputBytes: 4096,
    });
    expect(result).toMatchObject({ kind: "exited", status: 0, stdout: "export const a = 2;\n" });
    await copy.dispose();
  });

  it("applyPatch reverses a revert patch to the base content, and answers false for a patch that does not apply", async () => {
    const { parent, factory } = factoryIn();
    const copy = await factory.create(spec());
    const patch = await revertPatch(fx.quarantine, fx.base, fx.head, ["src/a.ts"]);
    expect(await copy.applyPatch(patch, { reverse: true })).toBe(true);
    expect(readFileSync(join(parent, copy.id, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(await copy.isClean()).toBe(false);
    expect(await copy.applyPatch(patch, { reverse: true })).toBe(false); // already reverted
    expect(await copy.applyPatch("not a patch\n", { reverse: false })).toBe(false);
    await copy.dispose();
  });

  it("dispose and abortSync remove everything the copy made, and either may repeat", async () => {
    const { parent, factory } = factoryIn();
    const a = await factory.create(spec());
    const b = await factory.create(spec());
    expect(readdirSync(parent).length).toBe(4); // two roots and two scratch holders
    await a.dispose();
    await a.dispose();
    b.abortSync();
    b.abortSync();
    expect(readdirSync(parent)).toEqual([]);
  });

  it("leaves nothing behind when the sha does not exist", async () => {
    const { parent, factory } = factoryIn();
    await expect(factory.create({ quarantine: fx.quarantine, sha: "0".repeat(40) })).rejects.toThrow();
    expect(readdirSync(parent)).toEqual([]);
  });
});

describe("sweepOrphanCopies", () => {
  it("removes only the copy directories of dead pids", async () => {
    const parent = realTempDir("omf-sweep-");
    for (const name of ["wc-4000000-aaaaaaaa", "wc-4000000-aaaaaaaa-s", `wc-${process.pid}-bbbbbbbb`, "other-dir", "wc-xyz-aaaaaaaa", "wc-4000000-short"]) {
      mkdirSync(join(parent, name));
    }
    const removed = await sweepOrphanCopies(parent, (pid) => pid === process.pid);
    expect(removed).toBe(2);
    expect(readdirSync(parent).sort()).toEqual(["other-dir", `wc-${process.pid}-bbbbbbbb`, "wc-4000000-short", "wc-xyz-aaaaaaaa"].sort());
  });

  it("returns 0 for a directory that does not exist", async () => {
    expect(await sweepOrphanCopies(join(realTempDir("omf-sweep-"), "none"))).toBe(0);
  });
});
