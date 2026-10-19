import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseUiPort } from "../../src/cli/ui.js";
import { CLI, harnessEnv, omf } from "../helpers/cli.js";
import { gitIn, makeGitRepo, makeTempDir } from "../helpers/tmp.js";

const children: Array<{ child: ChildProcess; closed: Promise<number | null> }> = [];

function launch(args: string[], cwd: string, home: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const tmp = extraEnv.TMPDIR ?? makeTempDir("omf-ui-cli-tmp-");
  const child = spawn(process.execPath, [CLI, "ui", ...args], {
    cwd,
    env: harnessEnv(home, { TMPDIR: tmp, ...extraEnv }),
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
  return { child, closed, ready, tmp, output: () => ({ stdout, stderr }) };
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
      expect(readdirSync(ui.tmp)).toEqual([]);
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
    await expect.poll(() => ui.output().stderr, { timeout: 10_000 }).toContain("could not open a browser");
    expect((await fetch(url)).status).toBe(200);
    expect(ui.output().stdout).toContain(url);
    const file = readFileSync(argsFile, "utf8").trim();
    expect(isAbsolute(file)).toBe(true);
    expect(file).not.toContain(new URL(url).pathname.slice(1, -1));
    expect(existsSync(dirname(file))).toBe(false);
    expect(readdirSync(ui.tmp)).toEqual([]);
    expect(ui.output().stderr).not.toContain("\x1b");
    expect(ui.output().stderr).not.toContain(file);
    expect(ui.output().stderr).not.toContain(url);
  });

  it("creates no launch artifact and never calls the opener with --no-open", async () => {
    const bin = makeTempDir("omf-ui-browser-");
    const argsFile = join(bin, "unexpected-opener-args");
    for (const name of ["open", "xdg-open"]) {
      writeFileSync(join(bin, name), '#!/bin/sh\nprintf "%s\\n" "$@" > "$OMF_UI_OPEN_ARGS"\nexit 0\n', { mode: 0o755 });
    }
    const ui = launch(["--no-open"], makeGitRepo(), makeTempDir("omf-ui-home-"), {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      OMF_UI_OPEN_ARGS: argsFile,
    });
    const url = await ui.ready;
    expect((await fetch(url)).status).toBe(200);
    ui.child.kill("SIGTERM");
    expect(await ui.closed).toBe(0);
    expect(existsSync(argsFile)).toBe(false);
    expect(readdirSync(ui.tmp)).toEqual([]);
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "removes the launch file and exits on %s while an opener is still blocked",
    async (signal) => {
      const repo = makeGitRepo();
      const home = makeTempDir("omf-ui-home-");
      const bin = makeTempDir("omf-ui-browser-");
      const argsFile = join(bin, "opener-args");
      const release = join(bin, "release");
      for (const name of ["open", "xdg-open"]) {
        writeFileSync(
          join(bin, name),
          `#!/bin/sh\nexec "$OMF_TEST_NODE" -e 'const fs = require("node:fs"); fs.writeFileSync(process.env.OMF_UI_OPEN_ARGS, process.argv[1] + "\\n"); const timer = setInterval(() => { if (fs.existsSync(process.env.OMF_UI_RELEASE)) clearInterval(timer); }, 20); setTimeout(() => process.exit(0), 5000).unref();' "$@"\n`,
          { mode: 0o755 },
        );
      }
      const ui = launch([], repo, home, {
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        OMF_TEST_NODE: process.execPath,
        OMF_UI_OPEN_ARGS: argsFile,
        OMF_UI_RELEASE: release,
      });
      try {
        const url = await ui.ready;
        await expect.poll(() => existsSync(argsFile), { timeout: 10_000 }).toBe(true);
        const file = readFileSync(argsFile, "utf8").trim();
        expect(readFileSync(file, "utf8")).toContain(url);
        expect((await fetch(url)).status).toBe(200);
        ui.child.kill(signal);
        expect(await ui.closed).toBe(0);
        expect(existsSync(dirname(file))).toBe(false);
        expect(readdirSync(ui.tmp)).toEqual([]);
        expect(ui.output().stderr).toBe("");
      } finally {
        writeFileSync(release, "release");
      }
    },
  );

  it("retains a launch file after a successful opener until the UI closes", async () => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-ui-home-");
    const bin = makeTempDir("omf-ui-browser-");
    const argsFile = join(bin, "opener-args");
    for (const name of ["open", "xdg-open"]) {
      writeFileSync(join(bin, name), '#!/bin/sh\nprintf "%s\\n" "$@" > "$OMF_UI_OPEN_ARGS"\nexit 0\n', { mode: 0o755 });
    }
    const ui = launch([], repo, home, {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      OMF_UI_OPEN_ARGS: argsFile,
    });
    const url = await ui.ready;
    await expect.poll(() => existsSync(argsFile), { timeout: 10_000 }).toBe(true);
    const file = readFileSync(argsFile, "utf8").trim();
    expect(readFileSync(file, "utf8")).toContain(url);
    expect((await fetch(url)).status).toBe(200);
    ui.child.kill("SIGTERM");
    expect(await ui.closed).toBe(0);
    expect(existsSync(dirname(file))).toBe(false);
    expect(ui.output().stderr).toBe("");
  });

  it.each(["missing opener", "unwritable temp location"])("keeps the printed URL usable after %s", async (failure) => {
    const repo = makeGitRepo();
    const home = makeTempDir("omf-ui-home-");
    const bin = makeTempDir("omf-ui-browser-");
    const git = (process.env.PATH ?? "")
      .split(delimiter)
      .map((entry) => join(entry, "git"))
      .find(existsSync);
    expect(git).toBeDefined();
    symlinkSync(git as string, join(bin, "git"));
    const extraEnv: NodeJS.ProcessEnv = { PATH: bin };
    if (failure === "unwritable temp location") {
      const file = join(bin, "not-a-directory");
      writeFileSync(file, "fixture");
      extraEnv.TMPDIR = file;
    }
    const ui = launch([], repo, home, extraEnv);
    const url = await ui.ready;
    await expect.poll(() => ui.output().stderr, { timeout: 10_000 }).toContain("could not open a browser");
    expect((await fetch(url)).status).toBe(200);
    expect(ui.output().stdout).toContain(url);
    expect(ui.output().stderr).not.toContain(url);
    expect(ui.output().stderr).not.toContain(ui.tmp);
    if (failure === "missing opener") expect(readdirSync(ui.tmp)).toEqual([]);
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
