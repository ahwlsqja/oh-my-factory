import { spawn } from "node:child_process";
import { chmodSync, closeSync, fchmodSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Command, InvalidArgumentError } from "commander";
import { resolveProject } from "../core/paths.js";
import { startUiServer } from "../ui/server.js";

export function parseUiPort(value: string): number {
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new InvalidArgumentError("port must be an integer from 0 to 65535");
  }
  return port;
}

export interface UiBrowserLaunch {
  opened: Promise<void>;
  close(): void;
}

/** Keep the capability out of opener arguments; the private file lives until the UI session closes. */
export function openUiBrowser(url: string, platform: NodeJS.Platform = process.platform): UiBrowserLaunch {
  const command = platform === "darwin" ? "open" : platform === "linux" ? "xdg-open" : undefined;
  if (command === undefined) throw new Error("No browser opener is available.");
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/[a-f0-9]{48}\/$/.exec(url);
  if (match === null || match[0] !== url || Number(match[1]) > 65_535) throw new Error("Invalid UI browser URL.");

  let directory: string;
  try {
    directory = mkdtempSync(join(resolve(tmpdir()), "omf-ui-open-"));
  } catch {
    throw new Error("Could not prepare UI browser launch.");
  }
  let removed = false;
  const close = (): void => {
    if (removed) return;
    try {
      rmSync(directory, { recursive: true, force: true });
      removed = true;
      process.removeListener("exit", close);
    } catch {
      // Keep the exit hook so a transient removal failure can be retried. Never block server shutdown.
      console.error("warning: could not remove the temporary browser launch file.");
    }
  };
  process.once("exit", close);
  try {
    chmodSync(directory, 0o700);
    const file = join(directory, "open.html");
    const fd = openSync(file, "wx", 0o600);
    try {
      // Establish permissions before writing the capability, even under an unusual umask.
      fchmodSync(fd, 0o600);
      writeFileSync(
        fd,
        `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
          `<meta name="referrer" content="no-referrer">` +
          `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'">` +
          `<meta http-equiv="refresh" content="0; url=${url}"><title>Open OMF dashboard</title></head>` +
          `<body><a href="${url}" rel="noreferrer noopener">Open OMF dashboard</a></body></html>\n`,
      );
    } finally {
      closeSync(fd);
    }

    const child = spawn(command, [file], { stdio: "ignore", shell: false });
    const opened = new Promise<void>((resolve, reject) => {
      const fail = (): void => {
        close();
        reject(new Error("The browser opener failed."));
      };
      child.once("error", fail);
      child.once("exit", (code) => (code === 0 ? resolve() : fail()));
    });
    // Some Linux openers wait for the browser. Shutdown must not await the opened promise.
    child.unref();
    return { opened, close };
  } catch {
    close();
    throw new Error("Could not prepare UI browser launch.");
  }
}

export function registerUiCommand(program: Command): void {
  program
    .command("ui")
    .description("open a local read-only dashboard for this repository")
    .option("--port <port>", "loopback port (0 chooses an available port)", parseUiPort, 0)
    .option("--no-open", "print the URL without opening a browser")
    .action(async (options: { port: number; open: boolean }) => {
      // Preserve the CLI's normal outside-git error without initializing any project state.
      const cwd = process.cwd();
      resolveProject(cwd, process.env);
      const server = await startUiServer({ cwd, env: process.env, port: options.port });
      await new Promise<void>((resolve, reject) => {
        let browser: UiBrowserLaunch | undefined;
        const stop = (): void => {
          process.removeListener("SIGINT", stop);
          process.removeListener("SIGTERM", stop);
          browser?.close();
          void server.close().then(resolve, reject);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        console.log(`Read-only OMF UI: ${server.url}`);
        console.log("This dashboard cannot change OMF state. Press Ctrl+C to stop.");
        if (options.open) {
          const warn = (): void => {
            console.error("warning: could not open a browser; open the URL printed above.");
          };
          try {
            browser = openUiBrowser(server.url);
            void browser.opened.catch(warn);
          } catch {
            warn();
          }
        }
      });
    });
}
