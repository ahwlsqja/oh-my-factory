import { spawn } from "node:child_process";
import { registerCleanup } from "../core/cleanup-registry.js";

export interface ProcessOptions {
  cwd: string;
  /** Used verbatim; callers strip what the child must not see. */
  env: NodeJS.ProcessEnv;
  /** A string is sent as UTF-8; a Buffer is sent byte for byte (a tar stream for a work copy is not text). */
  stdin?: string | Buffer;
  timeoutMs: number;
  /** Combined stdout and stderr bytes; one byte more stops the command (or, with `tailOnly`, is dropped from the front). */
  maxOutputBytes: number;
  /**
   * Keeps only the last `maxOutputBytes` of each stream and never stops the command for the volume of its output. For a
   * command that may legitimately print a lot (a build) and whose success is decided by its exit status.
   */
  tailOnly?: boolean;
}

export type ProcessResult =
  | { kind: "exited"; status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
  | { kind: "timeout"; stdout: string; stderr: string }
  | { kind: "output_limit"; stdout: string; stderr: string }
  | { kind: "error"; code: string | null; message: string };

/** Process-group leader pids of the commands that are running now. */
const live = new Set<number>();
let exitHookInstalled = false;
let unregister: (() => void) | undefined;

/**
 * SIGKILLs the whole group of `pid` (a negative pid addresses the group). ESRCH means the group is already
 * gone, which is the normal case after a clean exit; any other failure means the group is not ours to
 * kill, and nothing more can be done about it, so no error is surfaced.
 */
function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone, or not ours
  }
}

function killAll(): void {
  for (const pid of live) killGroup(pid);
}

function onExit(): void {
  killAll();
}

/**
 * A detached group is not in the terminal's foreground group, so Ctrl-C never reaches it. The group killer is registered
 * with the shared cleanup registry as a `first` entry, so on SIGINT or SIGTERM it kills every live group before
 * any directory cleanup runs; then the registry takes its handlers off and re-raises the signal, so the process still
 * ends with the signal status instead of exit 0. The exit hook is the net for a normal exit.
 */
function installHandlers(): void {
  // Every run re-registers: the registry takes its signal handlers off after a signal, and a process that survives the
  // re-raise (another listener caught it) gets them back only on a registration. The previous entry is dropped first so
  // the registry never holds more than one. The entry is never removed after a run, so it stays for the life of the
  // process; the exit hook stays too, and killAll is idempotent.
  unregister?.();
  unregister = registerCleanup(killAll, { first: true });
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", onExit);
}

/** Number of process groups this module is running right now. A test seam: it is 0 after every command has settled. */
export function liveGroupCount(): number {
  return live.size;
}

/** Drops bytes from the front of `chunks` until at most `limit` are left. */
function trimToTail(chunks: Buffer[], limit: number): void {
  let size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  while (size > limit) {
    const first = chunks[0];
    if (first === undefined) return;
    const excess = size - limit;
    if (first.length <= excess) {
      chunks.shift();
      size -= first.length;
    } else {
      chunks[0] = first.subarray(excess);
      size = limit;
    }
  }
}

/**
 * Runs `argv` in its own process group and never lets the group outlive the call (spec §4.2: a measure
 * command is untrusted code). The group is SIGKILLed on timeout, when the output limit is hit, and right
 * after the command exits, so a background child cannot keep running or hold the output pipes open. A
 * descendant that leaves the group on its own (setsid) is out of reach, and can hold the pipes until the
 * timeout fires, which then reports `timeout`. SIGKILL of the parent cannot be caught, so a group may
 * outlive a parent that is killed that way.
 */
export function runProcessGroup(argv: readonly string[], options: ProcessOptions): Promise<ProcessResult> {
  const [program, ...args] = argv;
  if (program === undefined) return Promise.resolve({ kind: "error", code: null, message: "empty command" });
  installHandlers();
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(program, args, {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ kind: "error", code: (err as NodeJS.ErrnoException).code ?? null, message: (err as Error).message });
      return;
    }
    const pid = child.pid;
    if (pid !== undefined) live.add(pid);

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let total = 0;
    let settled = false;
    let exit: { status: number | null; signal: NodeJS.Signals | null } = { status: null, signal: null };
    const text = (): { stdout: string; stderr: string } => ({
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    });

    const timer = setTimeout(() => finish({ kind: "timeout", ...text() }), options.timeoutMs);
    function finish(result: ProcessResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pid !== undefined) {
        killGroup(pid);
        live.delete(pid);
      }
      resolve(result);
    }

    const collect =
      (sink: Buffer[]) =>
      (chunk: Buffer): void => {
        if (settled) return;
        if (options.tailOnly === true) {
          sink.push(chunk);
          trimToTail(sink, options.maxOutputBytes);
          return;
        }
        const room = options.maxOutputBytes - total;
        if (chunk.length > room) {
          sink.push(chunk.subarray(0, room));
          total = options.maxOutputBytes;
          finish({ kind: "output_limit", ...text() });
          return;
        }
        sink.push(chunk);
        total += chunk.length;
      };
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    // EPIPE when the command exits without reading its input; the exit status says what happened.
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.stdin);

    child.once("error", (err: NodeJS.ErrnoException) =>
      finish({ kind: "error", code: err.code ?? null, message: err.message }),
    );
    // "exit" rather than "close": a background child holds the pipes open, so "close" would wait for it.
    child.once("exit", (status, signal) => {
      exit = { status, signal };
      if (pid !== undefined) killGroup(pid);
    });
    child.once("close", () => finish({ kind: "exited", ...exit, ...text() }));
  });
}
