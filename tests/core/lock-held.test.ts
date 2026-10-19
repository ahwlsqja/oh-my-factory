import { spawnSync } from "node:child_process";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock, isLockHeld, releaseLock, sealLockFile } from "../../src/core/lock.js";
import { makeTempDir } from "../helpers/tmp.js";

// `isLockHeld` is read-only: a sweep asks it whether a running command still owns something, and must never take or break the lock.
describe("isLockHeld", () => {
  it("is false for a lock that does not exist, true while this process holds it, false after the release", () => {
    const dir = makeTempDir("omf-lock-held-");
    const path = join(dir, "x.lock");
    expect(isLockHeld(path)).toBe(false);
    acquireLock(path);
    expect(isLockHeld(path)).toBe(true);
    releaseLock(path);
    expect(isLockHeld(path)).toBe(false);
  });

  it("is false for a lock whose owner is gone, and leaves the file in place", () => {
    const dir = makeTempDir("omf-lock-held-");
    const path = join(dir, "x.lock");
    const dead = spawnSync(process.execPath, ["-e", "0"]);
    writeFileSync(path, JSON.stringify({ pid: dead.pid, start_time: null, acquired_at: "2026-10-01T00:00:00Z" }));
    expect(isLockHeld(path)).toBe(false);
    expect(isLockHeld(path)).toBe(false);
    expect(() => acquireLock(path)).not.toThrow();
  });

  it("treats a young file with no readable owner as held (mid-write) and an old one as free", () => {
    const dir = makeTempDir("omf-lock-held-");
    const path = join(dir, "x.lock");
    writeFileSync(path, "");
    expect(isLockHeld(path)).toBe(true);
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    expect(isLockHeld(path)).toBe(false);
  });

  it("names the seal lock of an item directory", () => {
    const dir = makeTempDir("omf-lock-held-");
    mkdirSync(join(dir, "item"));
    expect(sealLockFile(join(dir, "item"))).toBe(join(dir, "item", "seal.lock"));
  });
});
