import { createInterface } from "node:readline/promises";

/** The two flags `requireTerminal` reads; `process` satisfies it, a test passes plain objects. */
export interface TerminalStreams {
  stdin: { isTTY?: boolean };
  stdout: { isTTY?: boolean };
}

/** The two streams a confirmation prompt uses; `process.stdin` and `process.stdout` by default. */
export interface PromptStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/**
 * Refuses to go on without an interactive terminal. J-decisions are made by a person who has seen what
 * they are deciding (spec §6.2); with stdin or stdout piped, nobody is confirming anything, so no
 * decision command may proceed silently. `outcome` completes the message, so each command says what was
 * not done ("nothing was approved", "nothing was done").
 */
export function requireTerminal(
  action: string,
  outcome = "nothing was done",
  streams: TerminalStreams = process,
): void {
  if (!streams.stdin.isTTY || !streams.stdout.isTTY) {
    throw new Error(`${action} needs an interactive terminal; ${outcome}`);
  }
}

/**
 * Prints `prompt` and reads one line. True only when the trimmed line equals `expected`, which is the
 * thing being decided (a goal id, a work id), so confirming means retyping it rather than pressing enter.
 * Closing the input before a full line (Ctrl-D) is a decline, not a hang.
 */
export async function confirmByTyping(
  expected: string,
  prompt: string,
  io: PromptStreams = { input: process.stdin, output: process.stdout },
): Promise<boolean> {
  const rl = createInterface({ input: io.input, output: io.output });
  try {
    const closed = new Promise<string>((resolve) => rl.once("close", () => resolve("")));
    const answer = await Promise.race([rl.question(prompt), closed]);
    return answer.trim() === expected;
  } finally {
    rl.close();
  }
}
