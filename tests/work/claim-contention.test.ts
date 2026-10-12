import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LockHeldError } from "../../src/core/lock.js";
import { claimItem, claimStatus } from "../../src/work/claim.js";
import { runChild, waitForLine } from "../helpers/child.js";
import { makeTempDir } from "../helpers/tmp.js";

const CLAIM_MODULE = resolve("dist/work/claim.js");

/** Child: takes the claim, announces it, and keeps the process alive until the parent closes its stdin. */
const CLAIMER = `
const { claimItem } = await import(process.argv[1]);
claimItem(process.argv[2]);
process.stdout.write("claimed\\n");
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
`;

/** Child: increments a shared counter `rounds` times, each read-modify-write under item.lock. */
const COUNTER = `
const { withItemLock } = await import(process.argv[1]);
const { readFileSync, writeFileSync } = await import("node:fs");
const [dir, counter, rounds] = process.argv.slice(2);
for (let i = 0; i < Number(rounds); i++) {
  withItemLock(dir, () => writeFileSync(counter, String(Number(readFileSync(counter, "utf8")) + 1)), 10000);
}
`;

describe("work item locks across processes", () => {
  it("a claim held by another live process blocks a second claim, and is reclaimed once that process dies", async () => {
    const dir = makeTempDir();
    const child = spawn(process.execPath, ["--input-type=module", "-e", CLAIMER, CLAIM_MODULE, dir], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    await waitForLine(child, "claimed");
    expect(() => claimItem(dir)).toThrow(LockHeldError);
    expect(claimStatus(dir)).toMatchObject({ held: true, owner: { pid: child.pid } });
    const exited = new Promise<void>((done) => child.on("exit", () => done()));
    child.stdin?.end();
    await exited;
    expect(claimStatus(dir)).toMatchObject({ held: false, stale: true });
    expect(claimItem(dir).pid).toBe(process.pid);
  });

  it("item.lock never lets two processes in at once", async () => {
    const dir = makeTempDir();
    const counter = join(dir, "counter.txt");
    writeFileSync(counter, "0");
    const runs = await Promise.all([1, 2, 3, 4].map(() => runChild(COUNTER, [CLAIM_MODULE, dir, counter, "25"])));
    expect(runs.map((run) => run.code)).toEqual([0, 0, 0, 0]);
    expect(readFileSync(counter, "utf8")).toBe("100");
  });
});
