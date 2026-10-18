import { describe, expect, it } from "vitest";
import { codexArgv, refuseInteractive } from "../../src/author/codex-argv.js";

// covers: S5.3.author-one-shot-ephemeral
// W-author-no-interactive: the author is a one-shot ephemeral exec. Interactivity is refused by the shape of the argv,
// not by looking at the stdin of the OMF process, because `omf seal` is run by a person at a terminal.
describe("W-author-no-interactive: refuseInteractive", () => {
  const base = codexArgv({ model: null });

  it("accepts the argv the builder makes", () => {
    expect(refuseInteractive(base)).toBeNull();
    expect(refuseInteractive(codexArgv({ model: "gpt-5-codex" }))).toBeNull();
  });

  it.each([
    ["no exec subcommand", ["codex", ...base.slice(2)]],
    ["a different program", ["bash", ...base.slice(1)]],
    ["no --ephemeral", base.filter((part) => part !== "--ephemeral")],
    ["a tty flag", [...base, "--tty"]],
    ["a resume flag", [...base, "--resume"]],
    ["the resume subcommand", ["codex", "exec", "resume", ...base.slice(2)]],
    ["the login subcommand", ["codex", "login"]],
    ["an empty argv", []],
  ])("refuses %s", (_label, argv) => {
    expect(refuseInteractive(argv)).toBe("interactive");
  });
});
