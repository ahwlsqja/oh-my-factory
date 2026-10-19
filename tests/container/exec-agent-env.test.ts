import { describe, expect, it } from "vitest";
import { execArgv } from "../../src/container/argv.js";
import { ContainerSpecError } from "../../src/container/spec.js";

const NAME = "omf-author-r-20261019T000000Z-abcd-1-1";

const refused = (role: "author" | "implementer", env: Record<string, string>): boolean => {
  try {
    execArgv(NAME, { argv: ["env"], env, stdin: false, role }, null);
    return false;
  } catch (error) {
    return error instanceof ContainerSpecError && error.code === "invalid_exec";
  }
};

describe("an exec into an agent container sets no home, vendor or credential-shaped variable", () => {
  const BAD = [
    "HOME",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "CODEX_SOMETHING",
    "OPENAI_BASE_URL",
    "ANTHROPIC_BASE_URL",
    "MY_SERVICE_TOKEN",
    "DB_PASSWORD",
    "SOME_API_KEY",
  ];
  it.each(BAD)("refuses %s for both agent roles", (name) => {
    expect(refused("author", { [name]: "x" })).toBe(true);
    expect(refused("implementer", { [name]: "x" })).toBe(true);
  });

  it("still allows an ordinary name, and any name when no agent role is given", () => {
    expect(refused("author", { LANG_HINT: "x" })).toBe(false);
    expect(execArgv(NAME, { argv: ["env"], env: { HOME: "/x" }, stdin: false }, null)).toContain("HOME=/x");
  });
});
