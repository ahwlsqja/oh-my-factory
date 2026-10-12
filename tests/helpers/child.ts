import { type ChildProcess, spawn } from "node:child_process";

/** Runs an inline ES module script in a child node process and collects its stdout. */
export function runChild(script: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, ...args], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => void (out += chunk.toString()));
    child.on("error", fail);
    child.on("exit", (code) => done({ code: code ?? -1, out }));
  });
}

/** Resolves once `child` has printed `line` on stdout; rejects if it exits first. */
export function waitForLine(child: ChildProcess, line: string): Promise<void> {
  return new Promise((done, fail) => {
    let seen = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
      if (seen.includes(line)) done();
    });
    child.on("error", fail);
    child.on("exit", () => fail(new Error(`child exited before printing ${line}`)));
  });
}
