import { describe, expect, it } from "vitest";
import { omf } from "../helpers/cli.js";
import { makeGitRepo, makeTempDir } from "../helpers/tmp.js";

// OMF's colour policy: output is plain text. No command writes an escape byte, whatever the terminal says.
// If colour is ever added it must come with a helper that honours NO_COLOR, FORCE_COLOR and isatty first,
// and this test then gets cases for those settings (docs/README.md, "Output policy").
const ESC = "\x1b";

const HELP = [
  ["--help"],
  ["--version"],
  ["init", "--help"],
  ["doctor", "--help"],
  ["ledger", "--help"],
  ["ledger", "verify", "--help"],
  ["goal", "--help"],
  ["goal", "new", "--help"],
  ["goal", "audit", "--help"],
  ["goal", "measure", "--help"],
  ["goal", "status", "--help"],
  ["metric", "propose", "--help"],
  ["budget", "show", "--help"],
  ["work", "list", "--help"],
  ["decide", "--help"],
  ["veto", "--help"],
];

describe("no ANSI escape bytes", () => {
  // Colour-forcing variables must not change anything, so run once plain and once with FORCE_COLOR set.
  for (const [label, env] of [
    ["default environment", {}],
    ["FORCE_COLOR=1", { FORCE_COLOR: "1" }],
  ] as const) {
    describe(label, () => {
      const home = makeTempDir("omf-home-");
      const cwd = makeTempDir("omf-cwd-");

      it.each(HELP)("omf %s prints no escape byte", (...args) => {
        const result = omf(args, cwd, home, env);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).not.toContain(ESC);
        expect(result.stderr).not.toContain(ESC);
      });

      it("keeps error paths free of escape bytes", () => {
        const initialized = makeGitRepo();
        const cases: Array<{ args: string[]; cwd: string }> = [
          { args: ["no-such-command"], cwd },
          { args: ["goal", "new"], cwd },
          { args: ["init"], cwd },
          { args: ["goal", "new", "g-x"], cwd: initialized },
          { args: ["ledger", "verify"], cwd: initialized },
          { args: ["goal", "audit", "Bad Id"], cwd: initialized },
          { args: ["goal", "measure", "g-x", "--runner", "nope"], cwd: initialized },
        ];
        for (const c of cases) {
          const result = omf(c.args, c.cwd, home, env);
          expect(result.code, `${c.args.join(" ")}: ${result.stderr}`).not.toBe(0);
          expect(result.stdout, c.args.join(" ")).not.toContain(ESC);
          expect(result.stderr, c.args.join(" ")).not.toContain(ESC);
          expect(result.stderr.length, `${c.args.join(" ")} should explain itself`).toBeGreaterThan(0);
        }
      });
    });
  }
});
