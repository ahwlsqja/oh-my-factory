import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../helpers/tmp.js";

const LOCK_MODULE = resolve("dist/core/lock.js");

/** Child: increments a shared counter `rounds` times, each read-modify-write under withLockSync. */
const CHILD = `
const { withLockSync } = await import(process.argv[1]);
const { readFileSync, writeFileSync } = await import("node:fs");
const [lock, counter, rounds] = process.argv.slice(2);
for (let i = 0; i < Number(rounds); i++) {
  withLockSync(lock, () => {
    const n = Number(readFileSync(counter, "utf8"));
    writeFileSync(counter, String(n + 1));
  }, 10000);
}
`;

function runChild(lock: string, counter: string, rounds: number): Promise<number> {
  return new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", CHILD, LOCK_MODULE, lock, counter, String(rounds)],
      {
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
    child.on("error", fail);
    child.on("exit", (code) => done(code ?? -1));
  });
}

describe("lock contention across processes", () => {
  it("never lets two processes hold the lock at once", async () => {
    const dir = makeTempDir("omf-contention-");
    const lock = join(dir, "counter.lock");
    const counter = join(dir, "counter.txt");
    writeFileSync(counter, "0");
    const codes = await Promise.all([1, 2, 3, 4].map(() => runChild(lock, counter, 25)));
    expect(codes).toEqual([0, 0, 0, 0]);
    expect(readFileSync(counter, "utf8")).toBe("100");
  });
});
