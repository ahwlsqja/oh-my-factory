import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { liveGroupCount, runProcessGroup } from "../../src/adapters/process-group.js";
import { waitDead, waitForPids } from "../helpers/process.js";
import { makeTempDir } from "../helpers/tmp.js";

const options = (
  overrides: Partial<Parameters<typeof runProcessGroup>[1]> = {},
): Parameters<typeof runProcessGroup>[1] => ({
  cwd: makeTempDir(),
  env: { PATH: process.env.PATH },
  timeoutMs: 10_000,
  maxOutputBytes: 1024 * 1024,
  ...overrides,
});

// The shell backgrounds a long sleep, records "<shell pid> <sleep pid>", then either hangs or prints and exits.
const BACKGROUND_THEN_HANG = 'sleep 30 & echo "$$ $!" > "$1"; wait';
const BACKGROUND_THEN_EXIT = 'sleep 30 & echo "$$ $!" > "$1"; echo 5';

describe("runProcessGroup", () => {
  it("returns exit status, stdout and stderr", async () => {
    const result = await runProcessGroup(["sh", "-c", "echo out; echo err >&2; exit 3"], options());
    expect(result).toEqual({ kind: "exited", status: 3, signal: null, stdout: "out\n", stderr: "err\n" });
  });

  it("with tailOnly keeps the last bytes of a long output and still reports the exit", async () => {
    const result = await runProcessGroup(
      ["sh", "-c", "head -c 3000 /dev/zero | tr '\\0' 'x'; echo END; echo oops >&2; exit 0"],
      options({ maxOutputBytes: 100, tailOnly: true }),
    );
    expect(result).toMatchObject({ kind: "exited", status: 0, stderr: "oops\n" });
    if (result.kind !== "exited") return;
    expect(result.stdout).toHaveLength(100);
    expect(result.stdout.endsWith("xxxEND\n")).toBe(true);
  });

  it("delivers stdin", async () => {
    const result = await runProcessGroup(["cat"], options({ stdin: "hello" }));
    expect(result).toMatchObject({ kind: "exited", status: 0, stdout: "hello" });
  });

  it("delivers a binary Buffer on stdin byte for byte", async () => {
    // A tar stream for a work copy is not text: it must not pass through a UTF-8 string.
    const target = join(makeTempDir(), "stdin.bin");
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x0a, 0xc3, 0x28]);
    const result = await runProcessGroup(["sh", "-c", 'cat > "$1"', "sh", target], options({ stdin: bytes }));
    expect(result).toMatchObject({ kind: "exited", status: 0 });
    expect(readFileSync(target).equals(bytes)).toBe(true);
  });

  it("uses the given environment verbatim", async () => {
    const result = await runProcessGroup(
      ["sh", "-c", 'echo "$MARK:${HOME-unset}"'],
      options({ env: { PATH: process.env.PATH, MARK: "1" } }),
    );
    expect(result).toMatchObject({ kind: "exited", stdout: "1:unset\n" });
  });

  it("reports a missing program as an error, not a crash", async () => {
    const result = await runProcessGroup(["omf-no-such-program-xyz"], options());
    expect(result).toMatchObject({ kind: "error", code: "ENOENT" });
    expect(liveGroupCount()).toBe(0);
  });

  it("reports an empty argv as an error", async () => {
    expect(await runProcessGroup([], options())).toEqual({ kind: "error", code: null, message: "empty command" });
  });

  it("stops a command that prints more than the limit", async () => {
    const result = await runProcessGroup(["yes", "x"], options({ maxOutputBytes: 1000 }));
    expect(result.kind).toBe("output_limit");
    if (result.kind === "output_limit") expect(result.stdout.length).toBeLessThanOrEqual(1000);
  });

  it("kills the whole group on timeout, including a background child", async () => {
    const pidFile = join(makeTempDir(), "pids");
    const result = await runProcessGroup(
      ["sh", "-c", BACKGROUND_THEN_HANG, "sh", pidFile],
      options({ timeoutMs: 500 }),
    );
    expect(result.kind).toBe("timeout");
    const [shell, background] = await waitForPids(pidFile);
    expect(await waitDead(shell as number)).toBe(true);
    expect(await waitDead(background as number)).toBe(true);
    expect(liveGroupCount()).toBe(0);
  });

  it("leaves no orphan when the command exits but a background child keeps running", async () => {
    const pidFile = join(makeTempDir(), "pids");
    const result = await runProcessGroup(["sh", "-c", BACKGROUND_THEN_EXIT, "sh", pidFile], options());
    expect(result).toMatchObject({ kind: "exited", status: 0, stdout: "5\n" });
    const [, background] = await waitForPids(pidFile);
    expect(await waitDead(background as number)).toBe(true);
  });

  it("counts a live group while it runs and none afterwards", async () => {
    const running = runProcessGroup(["sh", "-c", "sleep 0.2"], options());
    expect(liveGroupCount()).toBe(1);
    await running;
    expect(liveGroupCount()).toBe(0);
  });
});

// The child is a separate node process that imports the built module, so a signal can be sent to it.
const DIST_URL = new URL("../../dist/adapters/process-group.js", import.meta.url).href;
const CHILD_SCRIPT = `
const [distUrl, pidFile, mode] = process.argv.slice(2);
const { runProcessGroup, liveGroupCount } = await import(distUrl);
const opts = { cwd: process.cwd(), env: process.env, timeoutMs: 120000, maxOutputBytes: 1024 };
const counts = () => ({ sigint: process.listenerCount("SIGINT"), sigterm: process.listenerCount("SIGTERM"), exit: process.listenerCount("exit") });
if (mode === "survive") {
  // A second listener lets the process live through the re-raised signal; the next command must re-arm the handlers.
  process.on("SIGTERM", () => {});
  const { existsSync } = await import("node:fs");
  const ready = async (f) => { while (!existsSync(f)) await new Promise((r) => setTimeout(r, 20)); await new Promise((r) => setTimeout(r, 100)); };
  void runProcessGroup(["sh", "-c", ${JSON.stringify(BACKGROUND_THEN_HANG)}, "sh", pidFile + ".a"], opts);
  await ready(pidFile + ".a");
  process.kill(process.pid, "SIGTERM");
  await new Promise((r) => setTimeout(r, 200));
  void runProcessGroup(["sh", "-c", ${JSON.stringify(BACKGROUND_THEN_HANG)}, "sh", pidFile + ".b"], opts);
  await ready(pidFile + ".b");
  process.kill(process.pid, "SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  // Read before exiting: the exit hook would kill the group too and hide a missing signal handler.
  const { readFileSync } = await import("node:fs");
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const sleepB = Number(readFileSync(pidFile + ".b", "utf8").trim().split(" ")[1]);
  console.log(JSON.stringify({ sleepBAlive: alive(sleepB) }));
  process.exit(0);
} else if (mode === "hang") {
  void runProcessGroup(["sh", "-c", ${JSON.stringify(BACKGROUND_THEN_HANG)}, "sh", pidFile], opts);
} else {
  const before = counts();
  await runProcessGroup(["sh", "-c", "exit 0"], opts);
  await runProcessGroup(["sh", "-c", "exit 0"], opts);
  console.log(JSON.stringify({ before, after: counts(), live: liveGroupCount() }));
}
`;

function childScript(): string {
  const file = join(makeTempDir(), "child.mjs");
  writeFileSync(file, CHILD_SCRIPT);
  return file;
}

describe("runProcessGroup signal cleanup", () => {
  it("installs its handlers once, however many commands run", () => {
    const result = spawnSync(process.execPath, [childScript(), DIST_URL, "", "once"], {
      encoding: "utf8",
      cwd: makeTempDir(),
    });
    expect(result.status).toBe(0);
    const seen = JSON.parse(result.stdout) as {
      before: Record<string, number>;
      after: Record<string, number>;
      live: number;
    };
    expect(seen.after.sigint).toBe((seen.before.sigint as number) + 1);
    expect(seen.after.sigterm).toBe((seen.before.sigterm as number) + 1);
    expect(seen.after.exit).toBe((seen.before.exit as number) + 1);
    expect(seen.live).toBe(0);
  });

  it.each(["SIGTERM", "SIGINT"] as const)(
    "a %s to the process kills the running group and keeps the signal status",
    async (signal) => {
      const pidFile = join(makeTempDir(), "pids");
      const child = spawn(process.execPath, [childScript(), DIST_URL, pidFile, "hang"], {
        stdio: "ignore",
        cwd: makeTempDir(),
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (code, sig) => resolve({ code, signal: sig }));
      });
      const [shell, background] = await waitForPids(pidFile);
      child.kill(signal);
      expect(await exited).toEqual({ code: null, signal });
      expect(await waitDead(shell as number)).toBe(true);
      expect(await waitDead(background as number)).toBe(true);
    },
  );

  it("a second signal still kills the group of a later command when the process survived the first", async () => {
    const pidFile = join(makeTempDir(), "pids");
    const result = spawnSync(process.execPath, [childScript(), DIST_URL, pidFile, "survive"], {
      encoding: "utf8",
      cwd: makeTempDir(),
      timeout: 15_000,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ sleepBAlive: false });
    const [shellA, sleepA] = await waitForPids(pidFile + ".a");
    const [shellB, sleepB] = await waitForPids(pidFile + ".b");
    for (const pid of [shellA, sleepA, shellB, sleepB]) expect(await waitDead(pid as number)).toBe(true);
  });
});
