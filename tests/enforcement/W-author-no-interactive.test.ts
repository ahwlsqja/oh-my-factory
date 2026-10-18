import { describe, expect, it } from "vitest";
import { codexArgv, refuseInteractive } from "../../src/author/codex-argv.js";
import { createContainerAuthor } from "../../src/author/codex-session.js";
import { authorDeps, authorDouble, authorRequest } from "../helpers/author-container.js";

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

describe("W-author-no-interactive: the docker invocation", () => {
  it("allocates no terminal on any exec and attaches stdin only where input is piped", async () => {
    const double = authorDouble();
    await createContainerAuthor(authorDeps(double)).run(authorRequest());
    const execs = double.fake.calls("exec");
    expect(execs).toHaveLength(5);
    for (const call of execs) {
      const name = call.argv.findIndex((part) => part.startsWith("omf-author-"));
      const flags = call.argv.slice(call.argv.indexOf("exec") + 1, name);
      for (const terminal of ["-t", "--tty", "-it", "--interactive"]) expect(flags).not.toContain(terminal);
    }
    // Three execs pipe stdin: the two `tar -x` and the Codex exec. The probe and `cat` do not.
    expect(execs.filter((call) => call.argv.includes("-i")).map((call) => call.argv.includes("codex"))).toEqual([
      false,
      false,
      true,
    ]);
  });
});
