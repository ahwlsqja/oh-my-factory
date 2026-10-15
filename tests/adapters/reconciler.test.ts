import { describe, expect, it } from "vitest";
import {
  ReconcileParseError,
  buildClaudeArgs,
  extractModelJson,
  reconcilerEnv,
  usedTools,
} from "../../src/adapters/reconciler.js";
import { CONFIG_DEFAULTS, type ReconcilerConfig } from "../../src/core/config.js";

const claude: ReconcilerConfig = { ...CONFIG_DEFAULTS.reconciler, kind: "claude" };

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

function parseError(fn: () => unknown): ReconcileParseError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ReconcileParseError) return err;
    throw err;
  }
  throw new Error("expected a ReconcileParseError");
}

describe("buildClaudeArgs", () => {
  it("disables tools, MCP, hooks, sessions and prompts, and takes the prompt from stdin", () => {
    const args = buildClaudeArgs(claude);
    expect(args).toContain("-p");
    expect(valueAfter(args, "--output-format")).toBe("json");
    // No --json-schema: Claude Code implements it with a synthetic tool call, which adds turns. OMF validates the answer itself.
    expect(args).not.toContain("--json-schema");
    // `--tools ""` is two argv elements: the flag and an empty string (an empty string disables every tool).
    expect(args.indexOf("--tools")).toBeGreaterThanOrEqual(0);
    expect(valueAfter(args, "--tools")).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--bare");
    expect(args).toContain("--no-session-persistence");
    expect(valueAfter(args, "--permission-mode")).toBe("dontAsk");
  });

  it("never asks for a permission bypass or an allow-list (spec §7: bypass only in L2/L3 containers)", () => {
    const joined = buildClaudeArgs({ ...claude, model: "claude-haiku-5-5", max_budget_usd: 1 }).join("\n");
    expect(joined).not.toContain("--dangerously-skip-permissions");
    expect(joined).not.toContain("bypassPermissions");
    expect(joined).not.toContain("--allowedTools");
    expect(joined).not.toContain("--allowed-tools");
    expect(joined).not.toContain("--add-dir");
  });

  it("adds the model and budget flags only when configured", () => {
    const plain = buildClaudeArgs(claude);
    expect(plain).not.toContain("--model");
    expect(plain).not.toContain("--max-budget-usd");
    const configured = buildClaudeArgs({ ...claude, model: "claude-haiku-5-5", max_budget_usd: 0.5 });
    expect(valueAfter(configured, "--model")).toBe("claude-haiku-5-5");
    expect(valueAfter(configured, "--max-budget-usd")).toBe("0.5");
  });
});

describe("reconcilerEnv", () => {
  const real: NodeJS.ProcessEnv = {
    PATH: "/p/bin:/usr/bin",
    HOME: "/real/home",
    ANTHROPIC_API_KEY: "sk-test",
    GITHUB_TOKEN: "g",
    AWS_SECRET_ACCESS_KEY: "a",
    INFISICAL_TOKEN: "i",
    OPENAI_API_KEY: "o",
    EXTRA: "e",
  };

  it("gives claude exactly PATH, a scratch HOME, the C locale, a scratch config dir and the API key", () => {
    expect(reconcilerEnv(claude, "/scratch", real)).toEqual({
      PATH: "/p/bin:/usr/bin",
      HOME: "/scratch",
      LC_ALL: "C",
      CLAUDE_CONFIG_DIR: "/scratch/claude-config",
      ANTHROPIC_API_KEY: "sk-test",
    });
  });

  it("leaves the key out when it is unset or empty, and falls back to a minimal PATH", () => {
    const env = reconcilerEnv(claude, "/scratch", { ANTHROPIC_API_KEY: "" });
    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/scratch",
      LC_ALL: "C",
      CLAUDE_CONFIG_DIR: "/scratch/claude-config",
    });
  });

  it("gives the command kind only PATH, HOME, LC_ALL and the names listed in env_passthrough", () => {
    const command: ReconcilerConfig = {
      ...CONFIG_DEFAULTS.reconciler,
      kind: "command",
      command: ["node", "stub.mjs"],
      env_passthrough: ["EXTRA", "MISSING", "HOME"],
    };
    // HOME is listed but the scratch HOME wins; a name the caller does not have is skipped.
    expect(reconcilerEnv(command, "/scratch", real)).toEqual({
      PATH: "/p/bin:/usr/bin",
      HOME: "/scratch",
      LC_ALL: "C",
      EXTRA: "e",
    });
  });
});

describe("extractModelJson", () => {
  const body = { candidates: [] };

  it("reads raw JSON from a command", () => {
    expect(extractModelJson("command", ` ${JSON.stringify(body)} \n`)).toEqual(body);
  });

  it("reads a claude envelope with structured_output", () => {
    const stdout = JSON.stringify({ type: "result", is_error: false, structured_output: body });
    expect(extractModelJson("claude", stdout)).toEqual(body);
  });

  it("reads a claude envelope whose result is fenced JSON", () => {
    const stdout = JSON.stringify({
      type: "result",
      is_error: false,
      result: `\`\`\`json\n${JSON.stringify(body)}\n\`\`\``,
    });
    expect(extractModelJson("claude", stdout)).toEqual(body);
  });

  it("reads a claude envelope whose result is bare JSON", () => {
    const stdout = JSON.stringify({ type: "result", is_error: false, result: JSON.stringify(body) });
    expect(extractModelJson("claude", stdout)).toEqual(body);
  });

  it("fails with the fixed code not_json and never quotes the input", () => {
    for (const kind of ["claude", "command"] as const) {
      const err = parseError(() => extractModelJson(kind, "SECRET-MODEL-TEXT {oops"));
      expect(err.code).toBe("not_json");
      expect(err.message).toBe("not_json");
      expect(err.message).not.toContain("SECRET");
    }
    const prose = JSON.stringify({ type: "result", result: "I refuse SECRET-PROSE" });
    const err = parseError(() => extractModelJson("claude", prose));
    expect(err.message).toBe("not_json");
    expect(err.message).not.toContain("SECRET");
    expect(parseError(() => extractModelJson("command", "")).code).toBe("not_json");
  });

  it("fails with envelope_shape on a claude envelope that carries no answer", () => {
    for (const stdout of [
      JSON.stringify({ type: "result", is_error: false }),
      JSON.stringify([]),
      JSON.stringify({ type: "result", is_error: true, result: JSON.stringify(body) }),
      JSON.stringify({ type: "result", result: 5 }),
    ]) {
      expect(parseError(() => extractModelJson("claude", stdout)).code).toBe("envelope_shape");
    }
  });
});

describe("usedTools", () => {
  it("accepts a single-turn envelope", () => {
    expect(
      usedTools({
        type: "result",
        num_turns: 1,
        permission_denials: [],
        usage: { server_tool_use: { web_search_requests: 0 } },
      }),
    ).toBe(false);
    expect(usedTools({ type: "result" })).toBe(false);
  });

  it("flags more than one turn, a denied tool attempt, or a server-side tool use", () => {
    expect(usedTools({ num_turns: 2 })).toBe(true);
    expect(usedTools({ num_turns: 1, permission_denials: [{ tool_name: "Bash" }] })).toBe(true);
    expect(usedTools({ num_turns: 1, usage: { server_tool_use: { web_search_requests: 1 } } })).toBe(true);
  });

  it("ignores values that are not an envelope object", () => {
    expect(usedTools(null)).toBe(false);
    expect(usedTools([])).toBe(false);
    expect(usedTools("num_turns")).toBe(false);
  });
});
