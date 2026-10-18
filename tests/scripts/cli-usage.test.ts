import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// scripts/cli-usage.mjs turns the built CLI's --help text into docs/cli-usage.md and compares the two (spec §13).
// These cases use a fake command tree, so they need no build. tests/enforcement/W-cli-usage-drift.test.ts runs the real one.
const SCRIPT = fileURLToPath(new URL("../../scripts/cli-usage.mjs", import.meta.url));

interface Block {
  path: string;
  help: string;
}
const usage = (await import(SCRIPT)) as {
  discoverLeaves: (runHelp: (prefix: string[]) => string) => Block[];
  renderUsage: (blocks: Block[]) => string;
  parseUsage: (text: string) => Block[];
  compareUsage: (expected: Block[], text: string) => string[];
  parseArgs: (argv: string[]) => { mode: string; file: string; cli: string } | { error: string };
};

const TREE: Record<string, string> = {
  "": "Usage: omf [options] [command]\n\nCommands:\n  init            create state\n  goal            goals\n  help [command]  display help\n",
  goal: "Usage: omf goal [options] [command]\n\nCommands:\n  tick [options] <id>  one pass\n",
  init: "Usage: omf init [options]\n\nOptions:\n  -h, --help  display help\n",
  "goal tick": "Usage: omf goal tick [options] <id>\n\nOptions:\n  --json  print JSON\n",
};
const runHelp = (prefix: string[]): string => {
  const text = TREE[prefix.join(" ")];
  if (text === undefined) throw new Error(`no help for "${prefix.join(" ")}"`);
  return text;
};
const blocks = (): Block[] => usage.discoverLeaves(runHelp);

describe("cli-usage generator", () => {
  it("finds the leaf commands in registration order and skips help", () => {
    expect(blocks().map((block) => block.path)).toEqual(["init", "goal tick"]);
  });

  it("renders blocks that parse back to the same text", () => {
    const text = usage.renderUsage(blocks());
    expect(usage.parseUsage(text)).toEqual(blocks().map((b) => ({ path: b.path, help: b.help.replace(/\n+$/, "") })));
    expect(usage.compareUsage(blocks(), text)).toEqual([]);
  });

  it("names the verb whose block differs by one character", () => {
    const text = usage.renderUsage(blocks()).replace("print JSON", "print JSOM");
    expect(usage.compareUsage(blocks(), text)).toEqual(["omf goal tick: the block differs from --help"]);
  });

  it("names a command that has no block and a block that has no command", () => {
    expect(usage.compareUsage(blocks(), usage.renderUsage(blocks().slice(1)))).toEqual([
      "omf init: no block in docs/cli-usage.md",
    ]);
    const extra = usage.renderUsage([...blocks(), { path: "ghost", help: "Usage: omf ghost\n" }]);
    expect(usage.compareUsage(blocks(), extra)).toEqual(["omf ghost: block for a command that no longer exists"]);
  });

  it("is byte exact: text outside the blocks cannot be edited", () => {
    const text = usage.renderUsage(blocks()).replace("# Command usage", "# Usage");
    expect(usage.compareUsage(blocks(), text)).toEqual(["docs/cli-usage.md: text outside the blocks was edited"]);
  });

  it("refuses a help text that holds a code fence", () => {
    expect(() => usage.renderUsage([{ path: "x", help: "```\n" }])).toThrow(/code fence/);
  });

  it("parses its arguments", () => {
    expect(usage.parseArgs(["--check"])).toEqual({ mode: "check", file: "docs/cli-usage.md", cli: "dist/cli/main.js" });
    expect(usage.parseArgs(["--write", "--file", "x.md"])).toMatchObject({ mode: "write", file: "x.md" });
    expect(usage.parseArgs([])).toEqual({ error: "give --write or --check" });
    expect(usage.parseArgs(["--write", "--check"])).toEqual({ error: "give --write or --check, not both" });
    expect(usage.parseArgs(["--file"])).toEqual({ error: "--file needs a path" });
    expect(usage.parseArgs(["--nope"])).toEqual({ error: "unknown argument --nope" });
  });
});
