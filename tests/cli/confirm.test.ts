import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { confirmByTyping, requireTerminal } from "../../src/cli/confirm.js";

const tty = { isTTY: true };

// Spec §6.2: a decision that only a person may make needs a terminal, or nobody is confirming it.
describe("requireTerminal", () => {
  it("passes when stdin and stdout are terminals", () => {
    expect(() => requireTerminal("J8 budget raise", undefined, { stdin: tty, stdout: tty })).not.toThrow();
  });

  it("refuses when stdin is not a terminal, with the default tail", () => {
    expect(() => requireTerminal("J8 budget raise", undefined, { stdin: { isTTY: false }, stdout: tty })).toThrow(
      "J8 budget raise needs an interactive terminal; nothing was done",
    );
  });

  it("refuses when stdout is not a terminal, and when isTTY is absent (a pipe)", () => {
    expect(() => requireTerminal("J8 budget raise", undefined, { stdin: tty, stdout: {} })).toThrow(
      "needs an interactive terminal",
    );
  });

  it("lets the caller say what was not done", () => {
    expect(() => requireTerminal("J1 approval", "nothing was approved", { stdin: {}, stdout: {} })).toThrow(
      "J1 approval needs an interactive terminal; nothing was approved",
    );
  });
});

function fakeTerminal(): { input: PassThrough; output: PassThrough; shown: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = "";
  output.on("data", (chunk: Buffer) => {
    shown += chunk.toString("utf8");
  });
  return { input, output, shown: () => shown };
}

describe("confirmByTyping", () => {
  it("is true when the typed line equals the expected text, ignoring surrounding spaces", async () => {
    const io = fakeTerminal();
    const answer = confirmByTyping("g-fast", "Type g-fast to raise: ", io);
    io.input.write("  g-fast \n");
    await expect(answer).resolves.toBe(true);
    expect(io.shown()).toBe("Type g-fast to raise: ");
  });

  it("is false for any other answer", async () => {
    const io = fakeTerminal();
    const answer = confirmByTyping("g-fast", "Type g-fast: ", io);
    io.input.write("g-slow\n");
    await expect(answer).resolves.toBe(false);
  });

  it("is false when the input closes before an answer (Ctrl-D), instead of hanging", async () => {
    const io = fakeTerminal();
    const answer = confirmByTyping("g-fast", "Type g-fast: ", io);
    io.input.end();
    await expect(answer).resolves.toBe(false);
  });

  it("is false when the input closes in the middle of the line, because the line was never entered", async () => {
    const io = fakeTerminal();
    const answer = confirmByTyping("g-fast", "Type g-fast: ", io);
    io.input.write("g-fast");
    io.input.end();
    await expect(answer).resolves.toBe(false);
  });
});
