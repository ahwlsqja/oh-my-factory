import { describe, expect, it, vi } from "vitest";
import * as realArgv from "../../src/author/codex-argv.js";
import { codexArgv, refuseInteractive } from "../../src/author/codex-argv.js";
import { createContainerAuthor } from "../../src/author/codex-session.js";
import { authorDeps, authorDouble, authorRequest } from "../helpers/author-container.js";

// The builder only ever makes an accepted argv, so the guard in run() is reached through this seam: a test can make the
// builder answer with a refused argv and watch run() refuse before any container exists.
const argvOverride: { next: string[] | null } = { next: null };
vi.mock("../../src/author/codex-argv.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/author/codex-argv.js")>();
  return { ...actual, codexArgv: (input: { model: string | null }) => argvOverride.next ?? actual.codexArgv(input) };
});

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
    ["the login subcommand after exec", ["codex", "exec", "--ephemeral", "login"]],
    ["a bare -t", [...base, "-t"]],
    ["an empty argv", []],
  ])("refuses %s", (_label, argv) => {
    expect(refuseInteractive(argv)).toBe("interactive");
  });
});

describe("W-author-no-interactive: run() refuses a refused argv before it spends anything", () => {
  it.each([
    ["a tty flag", [...realArgv.codexArgv({ model: null }), "--tty"]],
    ["a bare -t", [...realArgv.codexArgv({ model: null }), "-t"]],
    ["the login subcommand after exec", ["codex", "exec", "--ephemeral", "login"]],
    ["no --ephemeral", ["codex", "exec", "-"]],
  ])("fails misconfigured with no docker call for %s", async (_label, argv) => {
    argvOverride.next = argv;
    try {
      const double = authorDouble();
      const author = createContainerAuthor(authorDeps(double));
      const outcome = await author.run(authorRequest());
      expect(outcome).toMatchObject({ ok: false, code: "misconfigured" });
      expect(double.fake.calls("exec")).toHaveLength(0);
      expect(double.runs).toHaveLength(0);
    } finally {
      argvOverride.next = null;
    }
  });
});

describe("W-author-no-interactive: a failed put", () => {
  // Each put is failed on its own, so a run that ignores one of them cannot hide behind the other.
  it.each([
    ["the inputs put", "/in"],
    ["the agent put", "/agent"],
  ])("is container_failed and never starts Codex when only %s fails", async (_label, dest) => {
    const double = authorDouble();
    const failed: string[] = [];
    double.fake.intercept = (argv) => {
      if (!argv.includes("tar")) return null;
      const target = argv[argv.indexOf("-C") + 1] ?? "";
      const hit = dest === "/in" ? target !== "/agent" : target === "/agent";
      if (!hit) return null;
      failed.push(target);
      return { kind: "exited", status: 1, signal: null, stdout: "", stderr: "x" };
    };
    const outcome = await createContainerAuthor(authorDeps(double)).run(authorRequest());
    expect(failed).toHaveLength(1);
    expect(outcome).toMatchObject({ ok: false, code: "container_failed" });
    expect(double.fake.calls("exec").some((call) => call.argv.includes("codex"))).toBe(false);
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
