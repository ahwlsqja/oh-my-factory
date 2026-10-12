import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { harnessEnv } from "./cli.js";
import { makeTempDir } from "./tmp.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("harnessEnv", () => {
  it("drops API keys and vendor settings that the test process inherited", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://example.invalid");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_ORG_ID", "org-test");
    vi.stubEnv("MISTRAL_API_KEY", "key-test");
    vi.stubEnv("GIT_DIR", "/nowhere");
    vi.stubEnv("OMF_HOME", "/nowhere");
    const env = harnessEnv("/tmp/omf-harness-home", {});
    const leaked = Object.keys(env).filter((key) => /_API_KEY$|^ANTHROPIC_|^OPENAI_|^GIT_|^OMF_HOME$/.test(key));
    expect(leaked).toEqual([]);
    expect(env.HOME).toBe("/tmp/omf-harness-home");
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("keeps a credential that a test passes explicitly, for the tests of key pass-through", () => {
    const env = harnessEnv("/tmp/omf-harness-home", { ANTHROPIC_API_KEY: "sk-ant-fixture" });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-fixture");
  });

  it("still fixes HOME, OMF_HOME and GIT_*", () => {
    expect(() => harnessEnv("/h", { HOME: "/x" })).toThrow("extraEnv may not set HOME");
    expect(() => harnessEnv("/h", { OMF_HOME: "/x" })).toThrow("extraEnv may not set OMF_HOME");
    expect(() => harnessEnv("/h", { GIT_DIR: "/x" })).toThrow("extraEnv may not set GIT_DIR");
  });
});

describe("agent CLI shims", () => {
  // `--version` keeps this harmless if the shims are missing and a real CLI answers; HOME is a scratch dir.
  it.each(["claude", "codex"])("resolves %s on the test PATH to a shim that exits 97", (tool) => {
    const result = spawnSync(tool, ["--version"], {
      encoding: "utf8",
      env: { ...process.env, HOME: makeTempDir("omf-home-") },
    });
    expect(result.status).toBe(97);
    expect(result.stderr).toContain("real model called from tests");
  });
});
