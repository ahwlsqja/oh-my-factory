import { spawn } from "node:child_process";
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

/** Pass the URL as one argument, never through a shell. The server survives an unavailable opener. */
export function openUiBrowser(url: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const command = platform === "darwin" ? "open" : platform === "linux" ? "xdg-open" : undefined;
  if (command === undefined) return Promise.reject(new Error("No browser opener is available."));
  return new Promise((resolve, reject) => {
    const child = spawn(command, [url], { stdio: "ignore", shell: false });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error("The browser opener failed."))));
    // Some Linux openers wait for the browser. They must not keep the UI process alive after shutdown.
    child.unref();
  });
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
        const stop = (): void => {
          process.removeListener("SIGINT", stop);
          process.removeListener("SIGTERM", stop);
          void server.close().then(resolve, reject);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        console.log(`Read-only OMF UI: ${server.url}`);
        console.log("This dashboard cannot change OMF state. Press Ctrl+C to stop.");
        if (options.open) {
          void openUiBrowser(server.url).catch(() => {
            console.error("warning: could not open a browser; open the URL printed above.");
          });
        }
      });
    });
}
