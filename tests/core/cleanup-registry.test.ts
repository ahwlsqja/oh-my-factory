import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runChild, waitForLine } from "../helpers/child.js";
import { waitDead, waitForPids } from "../helpers/process.js";
import { makeTempDir } from "../helpers/tmp.js";

const REGISTRY = JSON.stringify(new URL("../../dist/core/cleanup-registry.js", import.meta.url).href);
const PROCESS_GROUP = JSON.stringify(new URL("../../dist/adapters/process-group.js", import.meta.url).href);

/** Starts `script` as a child process and resolves with how it ended once `signal` was sent after it printed "ready". */
async function killedBy(script: string, signal: NodeJS.Signals) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, sig) => resolve({ code, signal: sig }));
  });
  await waitForLine(child, "ready");
  child.kill(signal);
  return ended;
}

describe("registerCleanup", () => {
  it("installs one handler pair on the first registration and removes it on the last unregister", async () => {
    const script = `
      import { registerCleanup } from ${REGISTRY};
      const counts = () => ({ sigint: process.listenerCount("SIGINT"), sigterm: process.listenerCount("SIGTERM") });
      const before = counts();
      const a = registerCleanup(() => {});
      const b = registerCleanup(() => {});
      const during = counts();
      a();
      const afterOne = counts();
      b();
      const afterAll = counts();
      const c = registerCleanup(() => {});
      const again = counts();
      c();
      console.log(JSON.stringify({ before, during, afterOne, afterAll, again, last: counts() }));
    `;
    const { code, out } = await runChild(script, []);
    expect(code).toBe(0);
    const seen = JSON.parse(out) as Record<string, { sigint: number; sigterm: number }>;
    const plusOne = { sigint: (seen.before?.sigint ?? 0) + 1, sigterm: (seen.before?.sigterm ?? 0) + 1 };
    expect(seen.during).toEqual(plusOne);
    expect(seen.afterOne).toEqual(plusOne);
    expect(seen.afterAll).toEqual(seen.before);
    expect(seen.again).toEqual(plusOne);
    expect(seen.last).toEqual(seen.before);
  });

  it("runs every callback on SIGTERM, a throwing one does not stop the rest, and the process ends with the signal status", async () => {
    const dir = makeTempDir("omf-registry-");
    const script = `
      import { writeFileSync } from "node:fs";
      import { registerCleanup } from ${REGISTRY};
      registerCleanup(() => writeFileSync(${JSON.stringify(join(dir, "a"))}, "a"));
      registerCleanup(() => { throw new Error("a callback that fails"); });
      registerCleanup(() => writeFileSync(${JSON.stringify(join(dir, "c"))}, "c"));
      const gone = registerCleanup(() => writeFileSync(${JSON.stringify(join(dir, "gone"))}, "x"));
      gone();
      console.log("ready");
      setInterval(() => {}, 60000);
    `;
    expect(await killedBy(script, "SIGTERM")).toEqual({ code: null, signal: "SIGTERM" });
    expect(existsSync(join(dir, "a"))).toBe(true);
    expect(existsSync(join(dir, "c"))).toBe(true);
    expect(existsSync(join(dir, "gone"))).toBe(false); // an unregistered callback does not run
  });

  it("does the same for SIGINT", async () => {
    const dir = makeTempDir("omf-registry-");
    const script = `
      import { writeFileSync } from "node:fs";
      import { registerCleanup } from ${REGISTRY};
      registerCleanup(() => writeFileSync(${JSON.stringify(join(dir, "a"))}, "a"));
      console.log("ready");
      setInterval(() => {}, 60000);
    `;
    expect(await killedBy(script, "SIGINT")).toEqual({ code: null, signal: "SIGINT" });
    expect(existsSync(join(dir, "a"))).toBe(true);
  });

  it.each(["SIGHUP", "SIGQUIT"] as const)(
    "does the same for %s, so a closed terminal or a quit key cleans up too",
    async (signal) => {
      const dir = makeTempDir("omf-registry-");
      const script = `
      import { writeFileSync } from "node:fs";
      import { registerCleanup } from ${REGISTRY};
      registerCleanup(() => writeFileSync(${JSON.stringify(join(dir, "a"))}, "a"));
      console.log("ready");
      setInterval(() => {}, 60000);
    `;
      expect(await killedBy(script, signal)).toEqual({ code: null, signal });
      expect(existsSync(join(dir, "a"))).toBe(true);
    },
  );

  it("installs a listener for each of the four signals with the first registration and removes all with the last", async () => {
    const script = `
      import { registerCleanup } from ${REGISTRY};
      const names = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];
      const counts = () => Object.fromEntries(names.map((n) => [n, process.listenerCount(n)]));
      const before = counts();
      const off = registerCleanup(() => {});
      const during = counts();
      off();
      console.log(JSON.stringify({ before, during, after: counts() }));
    `;
    const { code, out } = await runChild(script, []);
    expect(code).toBe(0);
    const seen = JSON.parse(out) as Record<string, Record<string, number>>;
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) {
      expect(seen.during?.[name]).toBe((seen.before?.[name] ?? 0) + 1);
      expect(seen.after?.[name]).toBe(seen.before?.[name]);
    }
  });

  it("a gate command under process-group and a registered copy cleanup are both handled on one SIGTERM", async () => {
    const dir = makeTempDir("omf-registry-");
    const copyDir = join(dir, "wc-copy");
    mkdirSync(copyDir);
    writeFileSync(join(copyDir, "tree-file"), "x");
    const pidFile = join(dir, "pids");
    const script = `
      import { rmSync } from "node:fs";
      import { registerCleanup } from ${REGISTRY};
      import { runProcessGroup } from ${PROCESS_GROUP};
      registerCleanup(() => rmSync(${JSON.stringify(copyDir)}, { recursive: true, force: true }));
      void runProcessGroup(["sh", "-c", 'sleep 30 & echo "$$ $!" > "$1"; wait', "sh", ${JSON.stringify(pidFile)}],
        { cwd: process.cwd(), env: process.env, timeoutMs: 120000, maxOutputBytes: 1024 });
      console.log("ready");
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "inherit"],
      cwd: dir,
    });
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, sig) => resolve({ code, signal: sig }));
    });
    await waitForLine(child, "ready");
    const [shell, background] = await waitForPids(pidFile);
    child.kill("SIGTERM");
    expect(await ended).toEqual({ code: null, signal: "SIGTERM" });
    expect(await waitDead(shell as number)).toBe(true);
    expect(await waitDead(background as number)).toBe(true);
    expect(existsSync(copyDir)).toBe(false);
  });

  it("runs a first-priority callback before the others on a signal, whatever the registration order", async () => {
    const dir = makeTempDir("omf-registry-");
    const script = `
      import { appendFileSync } from "node:fs";
      import { registerCleanup } from ${REGISTRY};
      const log = (name) => () => appendFileSync(${JSON.stringify(join(dir, "order"))}, name + "\\n");
      registerCleanup(log("early"));
      registerCleanup(log("kill"), { first: true });
      registerCleanup(log("late"));
      console.log("ready");
      setInterval(() => {}, 60000);
    `;
    expect(await killedBy(script, "SIGTERM")).toEqual({ code: null, signal: "SIGTERM" });
    expect(readFileSync(join(dir, "order"), "utf8")).toBe("kill\nearly\nlate\n");
  });

  it("process groups are killed before a directory cleanup registered earlier runs", async () => {
    const dir = makeTempDir("omf-registry-");
    const pidFile = join(dir, "pids");
    const seen = join(dir, "seen");
    const script = `
      import { readFileSync, writeFileSync } from "node:fs";
      import { execFileSync } from "node:child_process";
      import { registerCleanup } from ${REGISTRY};
      import { runProcessGroup } from ${PROCESS_GROUP};
      registerCleanup(() => {
        const [, background] = readFileSync(${JSON.stringify(pidFile)}, "utf8").trim().split(" ");
        let stat = "";
        try {
          stat = execFileSync("ps", ["-o", "stat=", "-p", background], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        } catch {
          // ps exits 1 when the pid is gone
        }
        writeFileSync(${JSON.stringify(seen)}, stat === "" || stat.startsWith("Z") ? "dead" : "alive");
      });
      void runProcessGroup(["sh", "-c", 'sleep 30 & echo "$$ $!" > "$1"; wait', "sh", ${JSON.stringify(pidFile)}],
        { cwd: process.cwd(), env: process.env, timeoutMs: 120000, maxOutputBytes: 1024 });
      console.log("ready");
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "inherit"],
      cwd: dir,
    });
    const ended = new Promise<unknown>((resolve) => child.once("exit", (code, sig) => resolve({ code, signal: sig })));
    await waitForLine(child, "ready");
    await waitForPids(pidFile);
    child.kill("SIGTERM");
    expect(await ended).toEqual({ code: null, signal: "SIGTERM" });
    expect(readFileSync(seen, "utf8")).toBe("dead");
  });
});
