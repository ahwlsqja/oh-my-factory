import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LockHeldError } from "../../src/core/lock.js";
import { claimFile, claimItem, claimStatus, itemLockFile, releaseItem, withItemLock } from "../../src/work/claim.js";
import { makeTempDir } from "../helpers/tmp.js";

describe("claim.lock and item.lock", () => {
  it("are two different files in the item directory", () => {
    expect(claimFile("/x/w-0123456789ab")).toBe("/x/w-0123456789ab/claim.lock");
    expect(itemLockFile("/x/w-0123456789ab")).toBe("/x/w-0123456789ab/item.lock");
  });

  it("claimStatus is not held while there is no claim", () => {
    expect(claimStatus(makeTempDir())).toEqual({ held: false, owner: null, stale: false });
  });

  it("records the owner, refuses a second claim and frees the item on release", () => {
    const dir = makeTempDir();
    const owner = claimItem(dir);
    expect(owner.pid).toBe(process.pid);
    expect(claimStatus(dir)).toMatchObject({ held: true, stale: false, owner: { pid: process.pid } });
    expect(() => claimItem(dir)).toThrow(LockHeldError);
    releaseItem(dir);
    expect(claimStatus(dir).held).toBe(false);
    expect(existsSync(claimFile(dir))).toBe(false);
    expect(claimItem(dir).pid).toBe(process.pid);
  });

  it("reclaims a claim whose owner process is gone", () => {
    const dir = makeTempDir();
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(claimFile(dir), JSON.stringify({ pid: dead, start_time: "x", acquired_at: "x" }));
    expect(claimStatus(dir)).toMatchObject({ held: false, stale: true });
    expect(claimItem(dir).pid).toBe(process.pid);
  });

  it("reclaims a claim whose pid was reused by another process (start time differs)", () => {
    const dir = makeTempDir();
    writeFileSync(
      claimFile(dir),
      JSON.stringify({ pid: process.pid, start_time: "Thu Jan  1 00:00:00 1970", acquired_at: "x" }),
    );
    expect(claimStatus(dir)).toMatchObject({ held: false, stale: true });
    expect(claimItem(dir).pid).toBe(process.pid);
  });

  it("treats a claim file with no readable owner as held, so a half-written claim is not stolen", () => {
    const dir = makeTempDir();
    writeFileSync(claimFile(dir), "");
    expect(claimStatus(dir)).toEqual({ held: true, owner: null, stale: false });
  });

  it("does not let a claim block item.lock, or item.lock block a claim", () => {
    const dir = makeTempDir();
    claimItem(dir);
    expect(withItemLock(dir, () => "wrote")).toBe("wrote");
    releaseItem(dir);
    withItemLock(dir, () => {
      expect(claimItem(dir).pid).toBe(process.pid);
    });
    releaseItem(dir);
  });

  it("times out only on a held item.lock, and releases it when the callback throws", () => {
    const dir = makeTempDir();
    expect(() => withItemLock(dir, () => withItemLock(dir, () => 1, 100))).toThrow(LockHeldError);
    expect(() =>
      withItemLock(dir, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(withItemLock(dir, () => "free again")).toBe("free again");
  });
});
