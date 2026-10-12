import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Ledger } from "../../src/core/ledger.js";
import { makeTempDir } from "../helpers/tmp.js";

const LEDGER_MODULE = resolve("dist/core/ledger.js");

/** Child: appends `rounds` events to the shared ledger, one Ledger instance per process. */
const CHILD = `
const { Ledger } = await import(process.argv[1]);
const [dir, rounds] = process.argv.slice(2);
const ledger = new Ledger(dir);
for (let i = 0; i < Number(rounds); i++) {
  ledger.append({ actor: "omf", type: "test.append", payload: { pid: process.pid, n: i } });
}
`;

function runChild(dir: string, rounds: number): Promise<number> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD, LEDGER_MODULE, dir, String(rounds)], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.on("error", fail);
    child.on("exit", (code) => done(code ?? -1));
  });
}

describe("ledger appends across processes", () => {
  it("keeps the chain intact when four processes append concurrently", async () => {
    const dir = makeTempDir("omf-ledger-contention-");
    const codes = await Promise.all([1, 2, 3, 4].map(() => runChild(dir, 15)));
    expect(codes).toEqual([0, 0, 0, 0]);
    expect(new Ledger(dir).verify()).toMatchObject({ ok: true, count: 60 });
  });
});
