import { describe, expect, it } from "vitest";
import {
  BYPASS_FLAGS,
  CLAUDE_SETTINGS_PATH,
  ClaudeArgvError,
  claudeArgv,
  claudeSettings,
} from "../../src/implementer/claude-argv.js";

const BASE = [
  "claude",
  "-p",
  "--output-format",
  "stream-json",
  "--verbose",
  "--settings",
  "/agent/settings.json",
  "--setting-sources",
  "user",
  "--no-session-persistence",
  "--dangerously-skip-permissions",
];

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    return err instanceof ClaudeArgvError ? err.code : `other: ${String(err)}`;
  }
  return "no error";
}

describe("claudeArgv", () => {
  it("is pinned byte for byte, with the model and budget flags last and in that order", () => {
    expect(claudeArgv({ model: null, maxBudgetUsd: null })).toEqual(BASE);
    expect(claudeArgv({ model: "claude-sonnet-5-5", maxBudgetUsd: 2.5 })).toEqual([
      ...BASE,
      "--model",
      "claude-sonnet-5-5",
      "--max-budget-usd",
      "2.5",
    ]);
    expect(CLAUDE_SETTINGS_PATH).toBe("/agent/settings.json");
    expect(BYPASS_FLAGS).toEqual(["--dangerously-skip-permissions"]);
  });

  it("never adds --bare (it would skip the settings and the config directory) and never carries the prompt", () => {
    const argv = claudeArgv({ model: "m1", maxBudgetUsd: 1 });
    expect(argv).not.toContain("--bare");
    // The prompt goes on stdin: nothing in argv is free text.
    expect(argv.some((part) => /\s/.test(part))).toBe(false);
  });

  it("floors the budget to a whole micro-dollar so the cap is never above the remaining budget", () => {
    const tail = (usd: number) => claudeArgv({ model: null, maxBudgetUsd: usd }).slice(BASE.length);
    expect(tail(5)).toEqual(["--max-budget-usd", "5"]);
    expect(tail(0.1234567)).toEqual(["--max-budget-usd", "0.123456"]);
  });

  it("refuses a model that could be read as a flag and a budget that is not a positive number", () => {
    for (const model of ["-x", "--model", "a b", "a\nb", "", "a".repeat(81)]) {
      expect(codeOf(() => claudeArgv({ model, maxBudgetUsd: null }))).toBe("invalid_model");
    }
    for (const usd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e-7]) {
      expect(codeOf(() => claudeArgv({ model: null, maxBudgetUsd: usd }))).toBe("invalid_budget");
    }
  });
});

describe("claudeSettings", () => {
  it("holds a sorted, de-duplicated deny list for edits of the test globs and nothing else", () => {
    const text = claudeSettings({ denyEditGlobs: ["tests/**", "**/*.test.ts", "tests/**"] });
    expect(JSON.parse(text)).toEqual({ permissions: { deny: ["Edit(**/*.test.ts)", "Edit(tests/**)"] } });
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(claudeSettings({ denyEditGlobs: [] }))).toEqual({ permissions: { deny: [] } });
  });

  it("carries no permission mode, key, token or host path", () => {
    const text = claudeSettings({ denyEditGlobs: ["tests/**"] });
    expect(text).not.toMatch(/bypass|defaultMode|apiKey|API_KEY|token|\/Users|\/home/i);
  });

  it("refuses a glob that is absolute, climbs out, breaks the rule syntax or hides a control character", () => {
    for (const glob of ["", "/etc/**", "~/x", "../x", "a/../b", "a(b)", "a\\b", "a\nb", "a\0b", "x".repeat(201)]) {
      expect(codeOf(() => claudeSettings({ denyEditGlobs: [glob] }))).toBe("invalid_glob");
    }
  });
});
