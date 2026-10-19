import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseUiPort } from "../../src/cli/ui.js";
import { CLI, harnessEnv, omf } from "../helpers/cli.js";
import { gitIn, makeGitRepo, makeTempDir } from "../helpers/tmp.js";

const children: Array<{ child: ChildProcess; closed: Promise<number | null> }> = [];

function launch(args: string[], cwd: string, home: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [CLI, "ui", ...args], {
    cwd,
    env: harnessEnv(home, extraEnv),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  children.push({ child, closed });
  let stdout = "";
  let stderr = "";
  const ready = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`UI did not start: ${stderr}`)), 15_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      const url = /http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+\//.exec(stdout)?.[0];
      if (url !== undefined) {
        clearTimeout(timeout);
        resolve(url);
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", () => {
      clearTimeout(timeout);
      reject(new Error(`UI exited before ready: ${stderr}`));
    });
  });
  return { child, closed, ready, output: () => ({ stdout, stderr }) };
}

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async ({ child, closed }) => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await closed;
    }),
  );
});

describe("omf ui", () => {
  it.each(["SIGINT", "SIGTERM"] as const)(
    "serves an uninitialized repository without writes, then closes on %s",
    async (signal) => {
      const repo = makeGitRepo();
      const home = makeTempDir("omf-ui-home-");
      const before = gitIn(repo, "status", "--porcelain");
      const ui = launch(["--no-open", "--port", "0"], repo, home);
      const url = await ui.ready;
      const html = await fetch(url);
      expect(html.status).toBe(200);
      const api = await fetch(new URL("api/snapshot", url));
      expect(api.status).toBe(200);
      expect(await api.json()).toMatchObject({ status: "uninitialized" });
      ui.child.kill(signal);
      expect(await ui.closed).toBe(0);
      await expect(fetch(url)).rejects.toThrow();
      expect(existsSync(join(home, ".omf"))).toBe(false);
      expect(gitIn(repo, "status", "--porcelain")).toBe(before);
      expect(ui.output().stdout).toContain("Read-only");
      expect(ui.output().stdout).not.toContain("\x1b");
      expect(ui.output().stderr).toBe("");
    },
  );

  it("keeps serving and prints a friendly warning when the browser opener fails", async () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-ui-home-");
    const bin = makeTempDir("omf-ui-browser-");
    const argsFile = join(bin, "opener-args");
    for (const name of ["open", "xdg-open"]) {
      writeFileSync(join(bin, name), '#!/bin/sh\nprintf "%s\\n" "$@" > "$OMF_UI_OPEN_ARGS"\nexit 1\n', { mode: 0o755 });
    }
    const ui = launch([], repo, home, {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      OMF_UI_OPEN_ARGS: argsFile,
    });
    const url = await ui.ready;
    await expect.poll(() => ui.output().stderr).toContain("could not open a browser");
    expect((await fetch(url)).status).toBe(200);
    expect(ui.output().stdout).toContain(url);
    expect(readFileSync(argsFile, "utf8")).toBe(`${url}\n`);
    expect(ui.output().stderr).not.toContain("\x1b");
  });

  it("documents its options and retains the normal outside-repository failure", () => {
    const cwd = makeTempDir();
    const home = makeTempDir("omf-ui-home-");
    const help = omf(["ui", "--help"], cwd, home);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--port <port>");
    expect(help.stdout).toContain("--no-open");
    const outside = omf(["ui", "--no-open"], cwd, home);
    expect(outside.code).toBe(2);
    expect(outside.stderr).toContain("not a git repository");
    expect(outside.stdout).not.toContain("http://");
  });

  it.each(["-1", "65536", "1.5", "NaN", "", "abc"])("rejects invalid CLI port %s before starting", (port) => {
    const result = omf(["ui", "--no-open", "--port", port], makeGitRepo(), makeTempDir());
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("port must be an integer from 0 to 65535");
    expect(result.stdout).not.toContain("http://");
  });

  it("accepts the full integer port range", () => {
    expect(parseUiPort("0")).toBe(0);
    expect(parseUiPort("65535")).toBe(65_535);
  });
});
