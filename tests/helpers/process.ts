import { readFileSync } from "node:fs";

/** True while a process with this pid exists (a zombie still counts until its parent reaps it). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Polls until `pid` is gone. Returns false if it is still alive after `timeoutMs`. */
export async function waitDead(pid: number, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isAlive(pid);
}

/** Polls until `file` holds one or more whole lines of the form "<digits>[ <digits>...]\n" and returns the numbers. */
export async function waitForPids(file: string, timeoutMs = 5000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = readFileSync(file, "utf8");
      if (/^\d+( \d+)*\n$/.test(text)) return text.trim().split(" ").map(Number);
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no pid file at ${file} after ${timeoutMs} ms`);
}
