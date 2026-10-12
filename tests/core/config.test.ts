import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/core/canonical-json.js";
import {
  CONFIG_DEFAULTS,
  ConfigError,
  EXTRA_HIGH_RISK_GLOBS,
  REFRESH,
  STOP_IF_UNREVIEWED_EVIDENCE,
  configSha256,
  parseConfig,
  readConfig,
} from "../../src/core/config.js";
import { DEFAULT_CONFIG, initProject } from "../../src/core/project.js";
import { makeGitRepo, makeTempDir } from "../helpers/tmp.js";

function projectWith(text: string): string {
  const dir = makeTempDir("omf-config-");
  writeFileSync(join(dir, "config.toml"), text);
  return dir;
}

describe("readConfig", () => {
  it("refuses a missing file instead of falling back to defaults (spec §11.5)", () => {
    const dir = makeTempDir("omf-config-");
    expect(() => readConfig(dir)).toThrow(ConfigError);
    expect(() => readConfig(dir)).toThrow(/config\.toml missing; run omf init/);
    expect(() => configSha256(dir)).toThrow(/run omf init/);
  });

  it("reads the file init wrote as exactly the defaults", () => {
    const home = makeTempDir("omf-home-");
    const { projectDir } = initProject(makeGitRepo(), { OMF_HOME: join(home, ".omf") });
    expect(readConfig(projectDir)).toEqual(CONFIG_DEFAULTS);
  });

  it("wraps a config.toml that cannot be read as a ConfigError", () => {
    const dir = makeTempDir("omf-config-");
    mkdirSync(join(dir, "config.toml"));
    expect(() => readConfig(dir)).toThrow(/config\.toml unreadable/);
    expect(() => configSha256(dir)).toThrow(ConfigError);
  });

  it("rejects a file whose sections have the wrong shape", () => {
    expect(() => readConfig(projectWith("reconciler = 1\n"))).toThrow(/config\.toml is invalid/);
  });
});

describe("parseConfig defaults", () => {
  it("parses the shipped default text to the defaults", () => {
    expect(parseConfig(DEFAULT_CONFIG)).toEqual(CONFIG_DEFAULTS);
  });

  it("ships the [reconciler] example commented out, so init never writes an active section", () => {
    expect(DEFAULT_CONFIG).toMatch(/^# \[reconciler\]$/m);
    expect(DEFAULT_CONFIG).not.toMatch(/^\[reconciler\]/m);
  });

  it("parses an empty file to the defaults", () => {
    expect(parseConfig("")).toEqual(CONFIG_DEFAULTS);
  });

  it("takes defaults for every section and key the file leaves out", () => {
    const config = parseConfig('[reconciler]\nkind = "command"\ncommand = ["node", "stub.js"]\ntimeout_ms = 5000\n');
    expect(config.reconciler).toEqual({
      kind: "command",
      model: null,
      command: ["node", "stub.js"],
      auth: "api_key",
      env_passthrough: [],
      timeout_ms: 5000,
      max_budget_usd: null,
    });
    expect(config.isolation).toEqual(CONFIG_DEFAULTS.isolation);
    expect(config.roles).toEqual(CONFIG_DEFAULTS.roles);
  });

  it("merges a single role over the role defaults", () => {
    const config = parseConfig('[roles]\nreconciler = { vendor = "claude", model = "some-model" }\n');
    expect(config.roles.reconciler).toEqual({ vendor: "claude", model: "some-model" });
    expect(config.roles.author).toEqual({ vendor: "codex" });
  });

  it("does not hand out the defaults' own arrays", () => {
    parseConfig("").reconciler.env_passthrough.push("LEAK");
    expect(CONFIG_DEFAULTS.reconciler.env_passthrough).toEqual([]);
  });

  it("exposes the M2b constants", () => {
    expect(STOP_IF_UNREVIEWED_EVIDENCE).toBe(3);
    expect(REFRESH).toEqual({ max_age: "14d", max_commits: 50, max_target_move: 1.0 });
    expect(EXTRA_HIGH_RISK_GLOBS).toEqual([]);
  });
});

describe("parseConfig rejections", () => {
  it("rejects text that is not TOML", () => {
    expect(() => parseConfig("[reconciler\nkind =")).toThrow(/config\.toml is not valid TOML/);
  });

  it("rejects an unknown section and an unknown key", () => {
    expect(() => parseConfig("[surprise]\nx = 1\n")).toThrow(/config\.toml is invalid/);
    expect(() => parseConfig("[reconciler]\nbogus = 1\n")).toThrow(/config\.toml is invalid/);
    expect(() => parseConfig('[roles]\njanitor = { vendor = "claude" }\n')).toThrow(/config\.toml is invalid/);
  });

  it.each(["stop_if", "refresh", "risk"])("rejects the [%s] table as not configurable in M2b", (name) => {
    expect(() => parseConfig(`[${name}]\nx = 1\n`)).toThrow(`[${name}] is not configurable in M2b`);
  });

  it('rejects kind = "command" without a command', () => {
    expect(() => parseConfig('[reconciler]\nkind = "command"\n')).toThrow(/requires reconciler\.command/);
    expect(() => parseConfig('[reconciler]\nkind = "command"\ncommand = []\n')).toThrow(/command/);
  });

  it("rejects a timeout outside 1000..600000", () => {
    expect(() => parseConfig("[reconciler]\ntimeout_ms = 5\n")).toThrow(/timeout_ms/);
    expect(() => parseConfig("[reconciler]\ntimeout_ms = 600001\n")).toThrow(/timeout_ms/);
    expect(parseConfig("[reconciler]\ntimeout_ms = 1000\n").reconciler.timeout_ms).toBe(1000);
  });

  it("rejects an env_passthrough entry that is not a variable name, and a non-positive budget", () => {
    expect(() => parseConfig('[reconciler]\nenv_passthrough = ["A=b"]\n')).toThrow(/env_passthrough/);
    expect(() => parseConfig("[reconciler]\nmax_budget_usd = 0\n")).toThrow(/max_budget_usd/);
  });

  it("says why codex and login_file are refused", () => {
    expect(() => parseConfig('[reconciler]\nkind = "codex"\n')).toThrow(/reconciler\.kind "codex" needs a container; M3/);
    expect(() => parseConfig('[roles]\nreconciler = { vendor = "codex" }\n')).toThrow(
      /roles\.reconciler\.vendor "codex" needs a container; M3/,
    );
    expect(() => parseConfig('[reconciler]\nauth = "login_file"\n')).toThrow(/reconciler\.auth "login_file" needs a container; M3/);
  });

  it("still allows codex for the roles M2b does not run", () => {
    expect(parseConfig('[roles]\nauthor = { vendor = "codex" }\njudge = { vendor = "codex" }\n').roles.judge.vendor).toBe("codex");
  });
});

describe("configSha256", () => {
  it("hashes the raw bytes and changes when one byte changes", () => {
    const text = '[reconciler]\ntimeout_ms = 5000\n';
    const dir = projectWith(text);
    const first = configSha256(dir);
    expect(first).toBe(sha256Hex(Buffer.from(text, "utf8")));
    expect(configSha256(dir)).toBe(first);
    writeFileSync(join(dir, "config.toml"), text.replace("5000", "5001"));
    expect(configSha256(dir)).not.toBe(first);
  });
});
