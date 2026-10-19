import { describe, expect, it } from "vitest";
import { reconcilerEnv } from "../../src/adapters/reconciler.js";
import { CONFIG_DEFAULTS, ConfigError, parseConfig, type ReconcilerConfig } from "../../src/core/config.js";

const DENIED = [
  "OMF_AUTHOR_API_KEY",
  "OMF_IMPLEMENTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "GITHUB_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
];

describe("env_passthrough deny list", () => {
  it.each(DENIED)("refuses %s when the config is loaded", (name) => {
    const toml = `[reconciler]\nkind = "command"\ncommand = ["node", "x.mjs"]\nenv_passthrough = ["${name}"]\n`;
    expect(() => parseConfig(toml)).toThrow(ConfigError);
    expect(() => parseConfig(toml)).toThrow(/env_passthrough/);
  });

  it("still accepts an ordinary name", () => {
    const toml = '[reconciler]\nkind = "command"\ncommand = ["node", "x.mjs"]\nenv_passthrough = ["EXTRA_OK"]\n';
    expect(parseConfig(toml).reconciler.env_passthrough).toEqual(["EXTRA_OK"]);
  });

  it.each(DENIED)("reconcilerEnv refuses %s even when the config object skipped the loader", (name) => {
    const config: ReconcilerConfig = {
      ...CONFIG_DEFAULTS.reconciler,
      kind: "command",
      command: ["node", "x.mjs"],
      env_passthrough: [name],
    };
    expect(() => reconcilerEnv(config, "/scratch", { [name]: "secret-value" })).toThrow(ConfigError);
  });
});
