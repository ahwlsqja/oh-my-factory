import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { schemaUrl } from "../../src/core/schema.js";
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
    expect(() => parseConfig('[reconciler]\nkind = "codex"\n')).toThrow(
      /reconciler\.kind "codex" is not available: it needs a credential decision that is not made yet/,
    );
    expect(() => parseConfig('[roles]\nreconciler = { vendor = "codex" }\n')).toThrow(
      /roles\.reconciler\.vendor "codex" is not available: it needs a credential decision that is not made yet/,
    );
    expect(() => parseConfig('[reconciler]\nauth = "login_file"\n')).toThrow(
      /reconciler\.auth "login_file" is not available: it needs a credential decision that is not made yet/,
    );
  });

  it("still allows codex for the roles M2b does not run", () => {
    expect(
      parseConfig('[roles]\nauthor = { vendor = "codex" }\njudge = { vendor = "codex" }\n').roles.judge.vendor,
    ).toBe("codex");
  });
});

describe("configSha256", () => {
  it("hashes the raw bytes and changes when one byte changes", () => {
    const text = "[reconciler]\ntimeout_ms = 5000\n";
    const dir = projectWith(text);
    const first = configSha256(dir);
    expect(first).toBe(sha256Hex(Buffer.from(text, "utf8")));
    expect(configSha256(dir)).toBe(first);
    writeFileSync(join(dir, "config.toml"), text.replace("5000", "5001"));
    expect(configSha256(dir)).not.toBe(first);
  });
});

describe("[w] table (per-item W limits, M3-D18)", () => {
  it("takes the defaults when the file has no [w] section (a missing section, not a missing file)", () => {
    expect(CONFIG_DEFAULTS.w).toEqual({ max_rounds: 3, max_model_usd: 5 });
    expect(parseConfig("").w).toEqual({ max_rounds: 3, max_model_usd: 5 });
    expect(parseConfig('[isolation]\ndeclared = "L2"\n').w).toEqual({ max_rounds: 3, max_model_usd: 5 });
  });

  it("overrides one key and keeps the default of the other", () => {
    expect(parseConfig("[w]\nmax_rounds = 7\n").w).toEqual({ max_rounds: 7, max_model_usd: 5 });
    expect(parseConfig("[w]\nmax_model_usd = 0.25\n").w).toEqual({ max_rounds: 3, max_model_usd: 0.25 });
    expect(parseConfig("[w]\nmax_rounds = 2\nmax_model_usd = 12\n").w).toEqual({ max_rounds: 2, max_model_usd: 12 });
  });

  it("accepts both ends of each range", () => {
    expect(parseConfig("[w]\nmax_rounds = 1\n").w.max_rounds).toBe(1);
    expect(parseConfig("[w]\nmax_rounds = 50\n").w.max_rounds).toBe(50);
    expect(parseConfig("[w]\nmax_model_usd = 10000\n").w.max_model_usd).toBe(10000);
  });

  it("does not hand out the defaults' own object", () => {
    parseConfig("").w.max_rounds = 99;
    expect(CONFIG_DEFAULTS.w.max_rounds).toBe(3);
  });

  it.each([
    ["max_rounds = 0"],
    ["max_rounds = 51"],
    ["max_rounds = 2.5"],
    ['max_rounds = "3"'],
    ["max_model_usd = 0"],
    ["max_model_usd = -1"],
    ["max_model_usd = 0.0000001"], // below one micro-dollar: microUsd() would reject it
    ["max_model_usd = nan"],
    ['max_model_usd = "5"'],
    ["max_model_usd = 10000.5"],
  ])("refuses [w] %s and names the key", (line) => {
    const key = line.split(" ")[0];
    expect(() => parseConfig(`[w]\n${line}\n`)).toThrow(new RegExp(`config\\.toml is invalid: .*/w/${key}`));
  });

  it("refuses an unknown key under [w]", () => {
    expect(() => parseConfig("[w]\nmax_rounds = 3\nbogus = 1\n")).toThrow(
      /data\/w must NOT have additional properties/,
    );
  });

  it("still refuses a missing config.toml instead of using the [w] defaults (spec §11.5)", () => {
    expect(() => readConfig(makeTempDir("omf-config-"))).toThrow(/config\.toml missing; run omf init/);
  });

  it("reads [w] through readConfig", () => {
    expect(readConfig(projectWith("[w]\nmax_rounds = 4\n")).w).toEqual({ max_rounds: 4, max_model_usd: 5 });
  });
});

describe("[judge]", () => {
  const D = "b".repeat(64);

  it("defaults to three repetitions, no images and no Docker context", () => {
    expect(parseConfig("").judge).toEqual({
      k: 3,
      sut_base_image: null,
      harness_base_image: null,
      docker_context: null,
      step_timeout_ms: 10_000,
      memory_mb: 512,
      cpus: 1,
      pids_limit: 256,
      tmp_tmpfs_mb: 64,
      scratch_tmpfs_mb: 64,
      work_tmpfs_mb: 256,
      state_tmpfs_mb: 16,
    });
    expect(CONFIG_DEFAULTS.judge.k).toBe(3);
  });

  it("merges a partial section over the defaults and accepts pinned images and a context name", () => {
    const judge = parseConfig(
      `[judge]\nk = 5\nsut_base_image = "node@sha256:${D}"\nharness_base_image = "node@sha256:${D}"\ndocker_context = "colima-omf"\n`,
    ).judge;
    expect(judge).toMatchObject({
      k: 5,
      sut_base_image: `node@sha256:${D}`,
      docker_context: "colima-omf",
      memory_mb: 512,
    });
  });

  it("keeps the [judge] example in the shipped config commented out", () => {
    expect(DEFAULT_CONFIG).toMatch(/^# \[judge\]$/m);
    expect(DEFAULT_CONFIG).not.toMatch(/^\[judge\]/m);
  });

  it.each([
    ["k below 2", "k = 1"],
    ["k above 10", "k = 11"],
    ["a fractional k", "k = 2.5"],
    ["a timeout below 1000", "step_timeout_ms = 999"],
    ["a memory limit below 64", "memory_mb = 63"],
    ["cpus above 4", "cpus = 4.5"],
    ["a pids limit below 16", "pids_limit = 15"],
    ["a zero tmpfs size", "tmp_tmpfs_mb = 0"],
    ["a context name that starts with a dash", 'docker_context = "-x"'],
    ["a context name with a space", 'docker_context = "a b"'],
    ["a context name of 65 characters", `docker_context = "${"a".repeat(65)}"`],
    ["cpus with three decimals", "cpus = 1.005"],
    ["cpus with three decimals just above the floor", "cpus = 0.101"],
    ["an unknown key", "network = true"],
  ])("refuses %s", (_name, line) => {
    expect(() => parseConfig(`[judge]\n${line}\n`)).toThrow(/config\.toml is invalid/);
  });

  it.each([
    ["a context name of 64 characters", `docker_context = "${"a".repeat(64)}"`],
    ["cpus with two decimals", "cpus = 0.29"],
    ["the cpus floor", "cpus = 0.1"],
    ["the cpus ceiling", "cpus = 4"],
  ])("accepts %s, which the argv layer accepts too", (_name, line) => {
    expect(() => parseConfig(`[judge]\n${line}\n`)).not.toThrow();
  });

  it("refuses an image that is not pinned by digest, before the schema runs", () => {
    expect(() => parseConfig('[judge]\nsut_base_image = "node:22"\n')).toThrow(
      "judge.sut_base_image must be pinned by digest",
    );
    expect(() => parseConfig(`[judge]\nharness_base_image = "node@sha256:${"B".repeat(64)}"\n`)).toThrow(
      "judge.harness_base_image must be pinned by digest",
    );
  });

  it("refuses an implementer model the container run cannot pass on, before any container is built", () => {
    for (const model of ["claude-sonnet-4-5[1m]", "-leading-dash", "has space", "a".repeat(81)]) {
      expect(() => parseConfig(`[roles]\nimplementer = { vendor = "claude", model = "${model}" }\n`)).toThrow(
        /config\.toml is invalid/,
      );
    }
    expect(
      parseConfig('[roles]\nimplementer = { vendor = "claude", model = "claude-sonnet-4-5.1:beta" }\n').roles
        .implementer.model,
    ).toBe("claude-sonnet-4-5.1:beta");
    expect(parseConfig('[roles]\nauthor = { vendor = "claude", model = "any model[1m]" }\n').roles.author.model).toBe(
      "any model[1m]",
    );
  });

  it("refuses tmpfs sizes that do not fit in memory_mb, because tmpfs is charged to the container", () => {
    // The work copy holds tmp (64) plus work (256) = 320 MiB.
    expect(() => parseConfig("[judge]\nmemory_mb = 256\n")).toThrow(
      /judge tmpfs sizes of the workcopy container \(320 MiB\) exceed judge\.memory_mb \(256\)/,
    );
    expect(() =>
      parseConfig("[judge]\nmemory_mb = 100\ntmp_tmpfs_mb = 90\nscratch_tmpfs_mb = 11\nwork_tmpfs_mb = 16\n"),
    ).toThrow(/sut container \(101 MiB\)/);
    expect(parseConfig("[judge]\nmemory_mb = 320\n").judge.memory_mb).toBe(320);
  });
});

describe("[implementer]", () => {
  const D = "c".repeat(64);

  it("defaults to no image, a 30 minute session and a 64 MiB log cap", () => {
    expect(parseConfig("").implementer).toEqual({
      image: null,
      timeout_ms: 1_800_000,
      memory_mb: 2048,
      cpus: 2,
      pids_limit: 512,
      tmp_tmpfs_mb: 256,
      work_tmpfs_mb: 1024,
      agent_tmpfs_mb: 256,
      max_log_bytes: 67_108_864,
      max_workspace_bytes: 268_435_456,
    });
    expect(CONFIG_DEFAULTS.implementer.max_log_bytes).toBe(64 * 1024 * 1024);
  });

  it("merges a partial section over the defaults and accepts a digest and a local image id", () => {
    const pinned = parseConfig(`[implementer]\nimage = "factory-impl@sha256:${D}"\ntimeout_ms = 60000\n`).implementer;
    expect(pinned).toMatchObject({ image: `factory-impl@sha256:${D}`, timeout_ms: 60_000, memory_mb: 2048 });
    expect(parseConfig(`[implementer]\nimage = "sha256:${D}"\n`).implementer.image).toBe(`sha256:${D}`);
  });

  it("does not hand out the defaults' own object", () => {
    const first = parseConfig("");
    first.implementer.memory_mb = 1;
    expect(CONFIG_DEFAULTS.implementer.memory_mb).toBe(2048);
    expect(parseConfig("").implementer.memory_mb).toBe(2048);
  });

  it("keeps the [implementer] example in the shipped config commented out and never configures a key", () => {
    expect(DEFAULT_CONFIG).toMatch(/^# \[implementer\]$/m);
    expect(DEFAULT_CONFIG).not.toMatch(/^\[implementer\]/m);
    expect(DEFAULT_CONFIG).not.toMatch(/(api_key|token|secret|password)\s*=/i);
  });

  it.each([
    ["a timeout below one minute", "timeout_ms = 59999"],
    ["a timeout above four hours", "timeout_ms = 14400001"],
    ["a memory limit below 256", "memory_mb = 255"],
    ["cpus above 16", "cpus = 16.5"],
    ["cpus with three decimals", "cpus = 1.005"],
    ["a pids limit below 16", "pids_limit = 15"],
    ["a zero tmp size", "tmp_tmpfs_mb = 0"],
    ["a work size below 16", "work_tmpfs_mb = 15"],
    ["a work size above 4096 (assertSpec refuses any tmpfs above 4096)", "work_tmpfs_mb = 4097"],
    ["an agent size below 16", "agent_tmpfs_mb = 15"],
    ["a log cap below 1 MiB", "max_log_bytes = 1048575"],
    ["a log cap above 1 GiB", "max_log_bytes = 1073741825"],
    ["a workspace cap below 1 MiB", "max_workspace_bytes = 1048575"],
    ["a docker context of its own", 'docker_context = "x"'],
    ["a key field", 'api_key = "x"'],
  ])("refuses %s", (_name, line) => {
    expect(() => parseConfig(`[implementer]\n${line}\n`)).toThrow(/config\.toml is invalid/);
  });

  it.each([
    ["the shortest timeout", "timeout_ms = 60000"],
    ["the longest timeout", "timeout_ms = 14400000"],
    ["the cpus floor", "cpus = 0.1"],
    ["the cpus ceiling", "cpus = 16"],
    ["the smallest log cap", "max_log_bytes = 1048576"],
    ["the largest log cap", "max_log_bytes = 1073741824"],
    ["the largest workspace cap", "max_workspace_bytes = 1073741824"],
  ])("accepts %s", (_name, line) => {
    expect(() => parseConfig(`[implementer]\n${line}\n`)).not.toThrow();
  });

  it.each([
    ["a tag", "node:22"],
    ["an empty string", ""],
    ["an upper case image id", `sha256:${D.toUpperCase()}`],
    ["a short image id", "sha256:abc"],
    ["a digest of 63 characters", `node@sha256:${"d".repeat(63)}`],
  ])("refuses an image that is %s, naming the key, before the schema runs", (_name, image) => {
    expect(() => parseConfig(`[implementer]\nimage = "${image}"\n`)).toThrow(
      "implementer.image must be pinned by digest or be a local image id",
    );
  });

  it("accepts a codex implementer in the config, because only the station that starts it refuses", () => {
    expect(parseConfig('[roles]\nimplementer = { vendor = "codex" }\n').roles.implementer).toEqual({ vendor: "codex" });
    expect(
      parseConfig('[roles]\nimplementer = { vendor = "claude", model = "some-model" }\n').roles.implementer,
    ).toEqual({ vendor: "claude", model: "some-model" });
    expect(parseConfig('[roles]\nauthor = { vendor = "codex" }\n').roles.author.vendor).toBe("codex");
  });

  it("refuses tmpfs sizes that do not fit in memory_mb, because tmpfs is charged to the container", () => {
    // tmp (256) + work (1024) + agent (256) = 1536 MiB.
    expect(() => parseConfig("[implementer]\nmemory_mb = 1024\n")).toThrow(
      /implementer tmpfs sizes \(1536 MiB\) exceed implementer\.memory_mb \(1024\)/,
    );
    expect(parseConfig("[implementer]\nmemory_mb = 1536\n").implementer.memory_mb).toBe(1536);
  });

  it("has exactly the closed key set, none of which can carry a credential", () => {
    const schema = JSON.parse(readFileSync(schemaUrl("config.schema.json"), "utf8")) as {
      properties: { implementer: { additionalProperties: boolean; properties: Record<string, unknown> } };
    };
    const { additionalProperties, properties } = schema.properties.implementer;
    expect(additionalProperties).toBe(false);
    expect(Object.keys(properties).sort()).toEqual(
      [
        "agent_tmpfs_mb",
        "cpus",
        "image",
        "max_log_bytes",
        "max_workspace_bytes",
        "memory_mb",
        "pids_limit",
        "timeout_ms",
        "tmp_tmpfs_mb",
        "work_tmpfs_mb",
      ].sort(),
    );
    for (const name of Object.keys(properties)) expect(name).not.toMatch(/key|token|secret|credential|password|env/i);
    expect(Object.keys(CONFIG_DEFAULTS.implementer).sort()).toEqual(Object.keys(properties).sort());
  });
});

describe("[author]", () => {
  const D = "c".repeat(64);

  it("defaults to no image, a ten minute call and tmpfs sizes that fit in 1 GiB", () => {
    expect(parseConfig("").author).toEqual({
      image: null,
      timeout_ms: 600_000,
      max_output_bytes: 1_048_576,
      max_calls: 10,
      memory_mb: 1024,
      cpus: 1,
      pids_limit: 256,
      tmp_tmpfs_mb: 64,
      in_tmpfs_mb: 16,
      out_tmpfs_mb: 16,
      agent_tmpfs_mb: 128,
    });
  });

  it("merges a partial section over the defaults and accepts a digest and a local image id", () => {
    const pinned = parseConfig(`[author]\nimage = "factory-author@sha256:${D}"\ntimeout_ms = 120000\n`).author;
    expect(pinned).toMatchObject({ image: `factory-author@sha256:${D}`, timeout_ms: 120_000, memory_mb: 1024 });
    expect(parseConfig(`[author]\nimage = "sha256:${D}"\n`).author.image).toBe(`sha256:${D}`);
  });

  it("does not hand out the defaults' own object", () => {
    parseConfig("").author.memory_mb = 1;
    expect(CONFIG_DEFAULTS.author.memory_mb).toBe(1024);
  });

  it("keeps the [author] example in the shipped config commented out and never configures a key", () => {
    expect(DEFAULT_CONFIG).toMatch(/^# \[author\]$/m);
    expect(DEFAULT_CONFIG).not.toMatch(/^\[author\]/m);
    expect(DEFAULT_CONFIG).not.toMatch(/(api_key|token|secret|password)\s*=/i);
  });

  it.each([
    ["a timeout below one minute", "timeout_ms = 59999"],
    ["a timeout above one hour", "timeout_ms = 3600001"],
    ["a memory limit below 256", "memory_mb = 255"],
    ["cpus above 8", "cpus = 8.5"],
    ["a pids limit below 16", "pids_limit = 15"],
    ["a zero tmp size", "tmp_tmpfs_mb = 0"],
    ["an input size of zero", "in_tmpfs_mb = 0"],
    ["an output size above 256", "out_tmpfs_mb = 257"],
    ["an agent size below 16", "agent_tmpfs_mb = 15"],
    ["a docker context of its own", 'docker_context = "x"'],
    ["a key field", 'api_key = "x"'],
  ])("refuses %s", (_name, line) => {
    expect(() => parseConfig(`[author]\n${line}\n`)).toThrow(/config\.toml is invalid/);
  });

  it.each([
    ["the shortest timeout", "timeout_ms = 60000"],
    ["the longest timeout", "timeout_ms = 3600000"],
    ["the cpus floor", "cpus = 0.1"],
    ["the cpus ceiling", "cpus = 8"],
  ])("accepts %s", (_name, line) => {
    expect(() => parseConfig(`[author]\n${line}\n`)).not.toThrow();
  });

  it.each([
    ["a tag", "codex-author:1"],
    ["an empty string", ""],
    ["an upper case image id", `sha256:${D.toUpperCase()}`],
    ["a digest of 63 characters", `codex-author@sha256:${"d".repeat(63)}`],
  ])("refuses an image that is %s, naming the key, before the schema runs", (_name, image) => {
    expect(() => parseConfig(`[author]\nimage = "${image}"\n`)).toThrow(
      "author.image must be pinned by digest or be a local image id",
    );
  });

  it("refuses tmpfs sizes that do not fit in memory_mb, because tmpfs is charged to the container", () => {
    // tmp (64) + in (16) + out (16) + agent (200) = 296 MiB.
    expect(() => parseConfig("[author]\nmemory_mb = 256\nagent_tmpfs_mb = 200\n")).toThrow(
      /author tmpfs sizes \(296 MiB\) exceed author\.memory_mb \(256\)/,
    );
    expect(parseConfig("[author]\nmemory_mb = 296\nagent_tmpfs_mb = 200\n").author.memory_mb).toBe(296);
  });

  it("has exactly the closed key set, none of which can carry a credential", () => {
    const schema = JSON.parse(readFileSync(schemaUrl("config.schema.json"), "utf8")) as {
      properties: { author: { additionalProperties: boolean; properties: Record<string, unknown> } };
    };
    const { additionalProperties, properties } = schema.properties.author;
    expect(additionalProperties).toBe(false);
    expect(Object.keys(properties).sort()).toEqual(
      [
        "agent_tmpfs_mb",
        "cpus",
        "image",
        "in_tmpfs_mb",
        "max_calls",
        "max_output_bytes",
        "memory_mb",
        "out_tmpfs_mb",
        "pids_limit",
        "timeout_ms",
        "tmp_tmpfs_mb",
      ].sort(),
    );
    for (const name of Object.keys(properties)) expect(name).not.toMatch(/key|token|secret|credential|password|env/i);
    expect(Object.keys(CONFIG_DEFAULTS.author).sort()).toEqual(Object.keys(properties).sort());
  });
});

describe("[seal] same_vendor", () => {
  it.each(["true", "false", '"acknowledged"'])(
    "refuses same_vendor = %s with the reason, and never reads it",
    (value) => {
      expect(() => parseConfig(`[seal]\nsame_vendor = ${value}\n`)).toThrow(
        /\[seal\] same_vendor is not available: no same-vendor pairing is runnable in v0\.1/,
      );
    },
  );

  it("refuses any other [seal] key and an empty [seal] table as unknown configuration", () => {
    expect(() => parseConfig("[seal]\nrounds = 2\n")).toThrow(/config\.toml is invalid/);
    expect(() => parseConfig("[seal]\n")).toThrow(/config\.toml is invalid/);
  });
});

describe("[author] caps", () => {
  it("defaults to ten calls per work item and a 1 MiB cap on the Codex output", () => {
    expect(parseConfig("").author).toMatchObject({ max_calls: 10, max_output_bytes: 1_048_576, timeout_ms: 600_000 });
  });

  it.each([
    ["max_calls = 0"],
    ["max_calls = 101"],
    ["max_calls = 1.5"],
    ["max_output_bytes = 65535"],
    ["max_output_bytes = 16777217"],
  ])("refuses %s", (line) => {
    expect(() => parseConfig(`[author]\n${line}\n`)).toThrow(/max_/);
  });

  it("accepts the edges", () => {
    const author = parseConfig("[author]\nmax_calls = 1\nmax_output_bytes = 65536\n").author;
    expect(author).toMatchObject({ max_calls: 1, max_output_bytes: 65_536 });
    expect(parseConfig("[author]\nmax_calls = 100\nmax_output_bytes = 16777216\n").author.max_calls).toBe(100);
  });
});
