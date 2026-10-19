import { ChildProcess, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openUiBrowser, type UiBrowserLaunch } from "../../src/cli/ui.js";
import { harnessEnv } from "../helpers/cli.js";
import { makeTempDir } from "../helpers/tmp.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    chmodSync: vi.fn(original.chmodSync),
    mkdtempSync: vi.fn(original.mkdtempSync),
    fchmodSync: vi.fn(original.fchmodSync),
    openSync: vi.fn(original.openSync),
    writeFileSync: vi.fn(original.writeFileSync),
    closeSync: vi.fn(original.closeSync),
    rmSync: vi.fn(original.rmSync),
  };
});

const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");

const token = "a".repeat(48);
const url = `http://127.0.0.1:12345/${token}/`;
const launches: UiBrowserLaunch[] = [];
let root: string;
let child: ChildProcess;

function launch(platform: NodeJS.Platform = "linux") {
  const result = openUiBrowser(url, platform);
  launches.push(result);
  return result;
}
function launchPath(): string {
  const path = vi.mocked(spawn).mock.calls.at(-1)?.[1]?.[0];
  expect(typeof path).toBe("string");
  return path as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  root = makeTempDir("omf-ui-launch-test-");
  vi.stubEnv("TMPDIR", root);
  child = new ChildProcess();
  vi.mocked(spawn).mockReturnValue(child);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const result of launches.splice(0)) result.close();
  vi.unstubAllEnvs();
});

describe("UI browser launcher host-process boundary", () => {
  it.each(["relative-temp", "-option-temp"])(
    "passes an absolute file to a real stub opener when TMPDIR is %s",
    (temporaryDirectory) => {
      const bin = join(root, "bin");
      const argsFile = join(root, "opener-args");
      fs.mkdirSync(bin);
      fs.mkdirSync(join(root, temporaryDirectory));
      for (const name of ["open", "xdg-open"]) {
        fs.writeFileSync(join(bin, name), '#!/bin/sh\nprintf "%s\\n" "$@" > "$OMF_UI_OPEN_ARGS"\n', { mode: 0o755 });
      }
      const script = `
        import { openUiBrowser } from ${JSON.stringify(new URL("../../dist/cli/ui.js", import.meta.url).href)};
        import { readFileSync, statSync, existsSync, readdirSync } from "node:fs";
        import { dirname } from "node:path";
        // Stand in for the UI server's live event loop while the unreferenced opener exits.
        const keepAlive = setInterval(() => {}, 1000);
        try {
          const browser = openUiBrowser(process.env.OMF_TEST_UI_URL);
          await browser.opened;
          const file = readFileSync(process.env.OMF_UI_OPEN_ARGS, "utf8").trim();
          const observed = {
            file,
            html: readFileSync(file, "utf8"),
            fileMode: statSync(file).mode & 0o777,
            directoryMode: statSync(dirname(file)).mode & 0o777,
          };
          browser.close();
          observed.cleaned = !existsSync(dirname(file));
          observed.remaining = readdirSync(process.env.TMPDIR);
          console.log(JSON.stringify(observed));
        } finally {
          clearInterval(keepAlive);
        }
      `;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: root,
        env: harnessEnv(root, {
          TMPDIR: temporaryDirectory,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          OMF_UI_OPEN_ARGS: argsFile,
          OMF_TEST_UI_URL: url,
        }),
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      const observed = JSON.parse(result.stdout) as {
        file: string;
        html: string;
        fileMode: number;
        directoryMode: number;
        cleaned: boolean;
        remaining: string[];
      };
      expect(observed.html).toContain(url);
      expect(observed).toMatchObject({ fileMode: 0o600, directoryMode: 0o700, cleaned: true, remaining: [] });
      expect(observed.file).not.toContain(token);
      expect(isAbsolute(observed.file), observed.file).toBe(true);
    },
  );

  it.each([
    ["darwin", "open"],
    ["linux", "xdg-open"],
  ] as const)("%s opens only a private local file using %s without capability argv", async (platform, command) => {
    const result = launch(platform);
    const file = launchPath();
    expect(isAbsolute(file)).toBe(true);
    expect(file.startsWith(`${root}/`)).toBe(true);
    expect(file).not.toContain(token);
    expect(spawn).toHaveBeenCalledExactlyOnceWith(command, [file], { stdio: "ignore", shell: false });
    expect(fs.statSync(dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const html = fs.readFileSync(file, "utf8");
    expect(html).toContain(url);
    expect(html).toMatch(/http-equiv=["']refresh["']/i);
    expect(html).toMatch(/name=["']referrer["'][^>]*content=["']no-referrer["']/i);
    expect(html).not.toMatch(/<script|<iframe|<img|<link|src\s*=/i);
    expect(html.match(/https?:\/\/[^\s"'<>]+/g)?.every((target) => target === url)).toBe(true);
    child.emit("exit", 0, null);
    await result.opened;
    // Openers can return before the browser consumes the file.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fs.readFileSync(file, "utf8")).toBe(html);
    result.close();
    result.close();
    expect(fs.existsSync(dirname(file))).toBe(false);
  });

  it("sets actual owner-only permissions before the first capability byte is written", async () => {
    const checks: number[] = [];
    vi.spyOn(fs, "writeFileSync").mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
      const fd = args[0];
      expect(typeof fd).toBe("number");
      expect(fs.fchmodSync).toHaveBeenCalledWith(fd, 0o600);
      expect(fs.fstatSync(fd as number).mode & 0o777).toBe(0o600);
      expect(fs.fstatSync(fd as number).size).toBe(0);
      const entries = fs.readdirSync(root);
      expect(entries).toHaveLength(1);
      expect(fs.statSync(join(root, entries[0] as string)).mode & 0o777).toBe(0o700);
      checks.push(1);
      return Reflect.apply(actualFs.writeFileSync, fs, args);
    });
    const previousUmask = process.umask(0o777);
    let result: UiBrowserLaunch;
    try {
      result = launch();
    } finally {
      process.umask(previousUmask);
    }
    expect(checks).toHaveLength(1);
    const openCall = vi.mocked(fs.openSync).mock.calls.at(-1);
    expect(openCall?.[1]).toBe("wx");
    expect(openCall?.[2]).toBe(0o600);
    child.emit("exit", 0, null);
    await result.opened;
  });

  it.each([
    url.replace(":12345", ":0"),
    url.replace("127.0.0.1", "localhost"),
    url.replace("http:", "https:"),
    url.replace("://", "://user@"),
    url.replace(":12345", ":65536"),
    url.replace(":12345", ":012345"),
    "http://127.0.0.1:12345/",
    "http://127.0.0.1:12345/token/",
    `${url}?q=;$(touch nowhere)`,
    `${url}#fragment`,
    `${url}index.html`,
    url.replace(token, token.toUpperCase()),
    url.replace(token, token.slice(1)),
    url.replace("127.0.0.1", "127.1"),
    url.replace(`/${token}/`, `/x/../${token}/`),
    `${url}\n`,
    `${url}\r\n`,
  ])("rejects a noncanonical target before creating artifacts or spawning: %s", (target) => {
    expect(() => openUiBrowser(target)).toThrow();
    expect(fs.readdirSync(root)).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("starts no process or artifact on an unsupported platform", () => {
    expect(() => openUiBrowser(url, "win32")).toThrow();
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it.each(["mkdtempSync", "chmodSync", "openSync", "fchmodSync", "writeFileSync", "closeSync"] as const)(
    "cleans up and reports a generic synchronous %s failure",
    (operation) => {
      vi.spyOn(fs, operation).mockImplementationOnce(() => {
        throw new Error(`private ${root} ${token}`);
      });
      let error: unknown;
      try {
        launch();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(root);
      expect(String(error)).not.toContain(token);
      expect(spawn).not.toHaveBeenCalled();
      expect(fs.readdirSync(root)).toEqual([]);
    },
  );

  it("cleans up when spawn itself throws", () => {
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw new Error(`private ${root} ${token}`);
    });
    expect(() => launch()).toThrow("Could not prepare UI browser launch.");
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it.each(["error", "nonzero", "signal"] as const)("cleans up after asynchronous opener %s", async (failure) => {
    const baseline = process.listenerCount("exit");
    const result = launch();
    const file = launchPath();
    const rejected = expect(result.opened).rejects.toThrow();
    if (failure === "error") child.emit("error", new Error(`private ${root} ${token}`));
    else child.emit("exit", failure === "nonzero" ? 1 : null, failure === "signal" ? "SIGTERM" : null);
    await rejected;
    expect(fs.existsSync(dirname(file))).toBe(false);
    expect(process.listenerCount("exit")).toBe(baseline);
  });

  it("removes its exit hook and artifact even when the opener never finishes", () => {
    const baseline = process.listenerCount("exit");
    const unref = vi.spyOn(child, "unref");
    const result = launch();
    const file = launchPath();
    expect(process.listenerCount("exit")).toBe(baseline + 1);
    expect(unref).toHaveBeenCalledOnce();
    result.close();
    expect(fs.existsSync(dirname(file))).toBe(false);
    expect(process.listenerCount("exit")).toBe(baseline);
  });

  it("registers an exit hook that removes its owned artifact", async () => {
    const baseline = new Set(process.listeners("exit"));
    const result = launch();
    const file = launchPath();
    child.emit("exit", 0, null);
    await result.opened;
    const cleanup = process.listeners("exit").filter((listener) => !baseline.has(listener));
    expect(cleanup).toHaveLength(1);
    // Invoke only this launch's exit callback, never the test runner's exit handlers.
    cleanup[0]?.(0);
    expect(fs.existsSync(dirname(file))).toBe(false);
    expect(process.listeners("exit").every((listener) => baseline.has(listener))).toBe(true);
  });

  it("warns without private details and permits retry when cleanup fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const baseline = process.listenerCount("exit");
    const result = launch();
    const file = launchPath();
    child.emit("exit", 0, null);
    await result.opened;
    vi.spyOn(fs, "rmSync").mockImplementationOnce(() => {
      throw new Error(`private ${root} ${token}`);
    });
    expect(() => result.close()).not.toThrow();
    expect(fs.existsSync(file)).toBe(true);
    const messages = [...error.mock.calls, ...warn.mock.calls].flat().join(" ");
    expect(messages).toMatch(/warning|cleanup|remove/i);
    expect(messages).not.toContain(token);
    expect(messages).not.toContain(root);
    expect(process.listenerCount("exit")).toBe(baseline + 1);
    result.close();
    expect(fs.existsSync(dirname(file))).toBe(false);
    expect(process.listenerCount("exit")).toBe(baseline);
  });
});
