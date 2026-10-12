import { spawnSync } from "node:child_process";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LockHeldError, acquireLock, processStartTime, releaseLock, withLockSync } from "../../src/core/lock.js";
import { makeTempDir } from "../helpers/tmp.js";

const lockPath = (): string => join(makeTempDir(), "work.lock");

describe("acquireLock", () => {
  it("records pid and start time, and refuses a second acquire", () => {
    const path = lockPath();
    const owner = acquireLock(path);
    expect(owner.pid).toBe(process.pid);
    expect(owner.start_time).toBe(processStartTime(process.pid));
    expect(() => acquireLock(path)).toThrow(LockHeldError);
  });

  it("can be acquired again after release", () => {
    const path = lockPath();
    acquireLock(path);
    releaseLock(path);
    expect(acquireLock(path).pid).toBe(process.pid);
  });

  it("reclaims a lock whose process has exited", () => {
    const path = lockPath();
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(path, JSON.stringify({ pid: dead, start_time: "x", acquired_at: "x" }));
    expect(acquireLock(path).pid).toBe(process.pid);
  });

  it("reclaims a lock whose pid was reused by another process", () => {
    const path = lockPath();
    writeFileSync(
      path,
      JSON.stringify({ pid: process.pid, start_time: "Thu Jan  1 00:00:00 1970", acquired_at: "x" }),
    );
    expect(acquireLock(path).pid).toBe(process.pid);
  });

  it("treats a fresh unreadable lock as held", () => {
    const path = lockPath();
    writeFileSync(path, "");
    expect(() => acquireLock(path)).toThrow(LockHeldError);
  });

  it("reclaims an unreadable lock older than the grace period", () => {
    const path = lockPath();
    writeFileSync(path, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    expect(acquireLock(path).pid).toBe(process.pid);
  });
});

describe("releaseLock", () => {
  it("refuses to release a lock owned by another live process", () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ pid: 1, start_time: null, acquired_at: "x" }));
    expect(() => releaseLock(path)).toThrow(/pid 1/);
  });
});

describe("withLockSync", () => {
  it("releases the lock when the callback throws", () => {
    const path = lockPath();
    expect(() =>
      withLockSync(path, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(acquireLock(path).pid).toBe(process.pid);
  });

  it("returns the callback result", () => {
    expect(withLockSync(lockPath(), () => 42)).toBe(42);
  });
});

describe("processStartTime", () => {
  it("returns a C-locale timestamp for a live pid", () => {
    expect(processStartTime(process.pid)).toMatch(/^[A-Z][a-z]{2} /);
  });
});
