import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { realTempDir } from "../helpers/ops-fixture.js";
import { waitForPids } from "../helpers/process.js";

const CHILD = fileURLToPath(new URL("../helpers/lifecycle-child.mjs", import.meta.url));

// Spec §5.5, M3f lifecycle: a round that is interrupted by SIGINT or SIGTERM removes every container it made, by name, before
// the process ends with the signal status. (SIGKILL cannot run a handler; `W-judge-leak-sweep` covers what it leaves.)
describe("W-judge-cleanup-on-kill", () => {
  it("SIGTERM in the middle of a round removes every container it made and keeps the signal status", async () => {
    const dir = realTempDir("omf-kill-");
    const log = join(dir, "log");
    const marker = join(dir, "ready");
    const child = spawn(process.execPath, [CHILD, "tracked", log, marker, join(dir, "judge")], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    await waitForPids(marker, 15_000); // both containers exist and the process is waiting inside the round
    child.kill("SIGTERM");
    expect(await ended).toEqual({ code: null, signal: "SIGTERM" });
    const lines = readFileSync(log, "utf8").trim().split("\n");
    const created = lines.filter((line) => line.startsWith("create ")).map((line) => line.slice("create ".length));
    const removed = lines
      .filter((line) => line.startsWith("removeAllSync "))
      .map((line) => line.slice("removeAllSync ".length));
    expect(created).toHaveLength(2);
    expect([...removed].sort()).toEqual([...created].sort());
  });
});
