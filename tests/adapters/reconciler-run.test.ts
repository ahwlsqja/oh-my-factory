import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type ReconcileRequest, createReconciler } from "../../src/adapters/reconciler.js";
import { CONFIG_DEFAULTS, ConfigError, type ReconcilerConfig } from "../../src/core/config.js";
import { makeTempDir } from "../helpers/tmp.js";

const STUB = fileURLToPath(new URL("../helpers/reconciler-stub.mjs", import.meta.url));
const ANSWER = '{"candidates":[]}';

interface Rig {
  project: string;
  record: string;
  bin: string;
  home: string;
  env: NodeJS.ProcessEnv;
}

/** A caller environment full of things that must not leak, a fake real home, and a PATH whose first entry is a temp bin dir. */
function rig(): Rig {
  const project = makeTempDir("omf-proj-");
  const record = makeTempDir("omf-rec-");
  const bin = makeTempDir("omf-bin-");
  const home = makeTempDir("omf-home-");
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), '{"keep":true}\n');
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    ANTHROPIC_API_KEY: "sk-test-key",
    GITHUB_TOKEN: "ghp-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    INFISICAL_TOKEN: "inf-secret",
    OPENAI_API_KEY: "sk-openai",
    EXTRA_OK: "1",
    EXTRA_NO: "1",
  };
  return { project, record, bin, home, env };
}

const LEAKED = ["GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "INFISICAL_TOKEN", "OPENAI_API_KEY", "EXTRA_NO"];

function writeFixture(r: Rig, text: string): string {
  const file = join(r.record, "fixture.json");
  writeFileSync(file, text);
  return file;
}

/** A `claude` on PATH that runs the stub, which prints the fixture and records the argv it was given. */
function installFakeClaude(r: Rig, fixture: string): void {
  const file = join(r.bin, "claude");
  writeFileSync(file, `#!/bin/sh\nexec '${process.execPath}' '${STUB}' print '${r.record}' '${fixture}' -- "$@"\n`);
  chmodSync(file, 0o755);
}

function claudeConfig(): ReconcilerConfig {
  return { ...CONFIG_DEFAULTS.reconciler, kind: "claude" };
}

function commandConfig(r: Rig, mode: string, fixture?: string, extra: Partial<ReconcilerConfig> = {}): ReconcilerConfig {
  const command = [process.execPath, STUB, mode, r.record, ...(fixture === undefined ? [] : [fixture])];
  return { ...CONFIG_DEFAULTS.reconciler, kind: "command", command, ...extra };
}

function request(prompt = "hello", timeoutMs = 20_000): ReconcileRequest {
  return { prompt, outputSchema: { type: "object" }, timeoutMs };
}

function recorded<T>(r: Rig, name: string): T {
  return JSON.parse(readFileSync(join(r.record, name), "utf8")) as T;
}

function envelope(extra: Record<string, unknown>): string {
  return JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, ...extra });
}

async function isDead(pid: number, withinMs = 2000): Promise<boolean> {
  const deadline = performance.now() + withinMs;
  while (performance.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        out[`${relative(dir, path)}/`] = "";
        walk(path);
      } else {
        out[relative(dir, path)] = readFileSync(path, "utf8");
      }
    }
  };
  walk(dir);
  return out;
}

describe("createReconciler: command kind", () => {
  it("delivers the prompt on stdin byte-exact and returns stdout", async () => {
    const r = rig();
    const fixture = writeFixture(r, ANSWER);
    const reconciler = createReconciler(r.project, commandConfig(r, "print", fixture), r.env);
    expect(reconciler.isolation).toBe("host-tool-less");
    expect(reconciler.id).toBe(`command:${basename(process.execPath)}+reconciler-stub.mjs`);
    const prompt = "-n --help\n---\ntitle: front matter\n---\né no trailing newline";
    const outcome = await reconciler.run(request(prompt));
    expect(outcome).toMatchObject({ ok: true, stdout: ANSWER });
    expect(readFileSync(join(r.record, "stdin.txt"))).toEqual(Buffer.from(prompt));
  });

  it("maps a non-zero exit, empty output and a missing program to fixed codes without quoting the child", async () => {
    const r = rig();
    const exited = await createReconciler(r.project, commandConfig(r, "exit3"), r.env).run(request());
    expect(exited).toMatchObject({ ok: false, code: "nonzero_exit", reason: "the reconciler exited with an error" });
    expect(JSON.stringify(exited)).not.toContain("SECRET-STDERR");

    const empty = await createReconciler(r.project, commandConfig(r, "empty"), r.env).run(request());
    expect(empty).toMatchObject({ ok: false, code: "no_output", reason: "the reconciler printed nothing" });

    const missing: ReconcilerConfig = { ...CONFIG_DEFAULTS.reconciler, kind: "command", command: ["/nonexistent/omf-reconciler"] };
    const spawnFailed = await createReconciler(r.project, missing, r.env).run(request());
    expect(spawnFailed).toMatchObject({ ok: false, code: "spawn_failed" });
  });

  it("stops output over 1 MiB", async () => {
    const r = rig();
    const outcome = await createReconciler(r.project, commandConfig(r, "big"), r.env).run(request());
    expect(outcome).toMatchObject({ ok: false, code: "output_limit" });
  });

  it("times out a hanging process and leaves no background child", async () => {
    const r = rig();
    const outcome = await createReconciler(r.project, commandConfig(r, "sleep"), r.env).run(request("hello", 2000));
    expect(outcome).toMatchObject({ ok: false, code: "timeout", reason: "the reconciler did not answer within the time limit" });
    const pid = Number(readFileSync(join(r.record, "child.pid"), "utf8"));
    expect(await isDead(pid)).toBe(true);
  });

  it("refuses a time limit that is not a positive number without spawning", async () => {
    const r = rig();
    const outcome = await createReconciler(r.project, commandConfig(r, "empty"), r.env).run(request("hello", 0));
    expect(outcome).toMatchObject({ ok: false, code: "misconfigured" });
    expect(existsSync(join(r.record, "stdin.txt"))).toBe(false);
  });

  it("passes only PATH, a scratch HOME, LC_ALL and the listed names, runs in an empty scratch dir and removes it", async () => {
    const r = rig();
    const fixture = writeFixture(r, ANSWER);
    const before = snapshot(r.home);
    const config = commandConfig(r, "print", fixture, { env_passthrough: ["EXTRA_OK"] });
    await createReconciler(r.project, config, r.env).run(request());
    const env = recorded<Record<string, string>>(r, "env.json");
    const where = recorded<{ cwd: string; entries: string[] }>(r, "cwd.json");
    expect(env.EXTRA_OK).toBe("1");
    expect(env.LC_ALL).toBe("C");
    expect(env.HOME).not.toBe(r.home);
    expect(basename(env.HOME ?? "")).toMatch(/^omf-reconcile-/);
    expect(basename(where.cwd)).toBe(basename(env.HOME ?? ""));
    for (const name of [...LEAKED, "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"]) expect(env).not.toHaveProperty(name);
    expect(where.entries).toEqual([]);
    expect(existsSync(where.cwd)).toBe(false);
    expect(snapshot(r.home)).toEqual(before);
  });

  it("throws ConfigError when the command kind has no command", () => {
    const r = rig();
    const config: ReconcilerConfig = { ...CONFIG_DEFAULTS.reconciler, kind: "command", command: null };
    expect(() => createReconciler(r.project, config, r.env)).toThrow(ConfigError);
  });
});

describe("createReconciler: claude kind", () => {
  it("runs claude with the isolating argv, the API key and a scratch config dir, and cleans up", async () => {
    const r = rig();
    installFakeClaude(r, writeFixture(r, envelope({ structured_output: { candidates: [] } })));
    const before = snapshot(r.home);
    const reconciler = createReconciler(r.project, claudeConfig(), r.env);
    expect(reconciler.id).toBe("claude");
    const outcome = await reconciler.run({ prompt: "p", outputSchema: { type: "object" }, timeoutMs: 20_000 });
    expect(outcome.ok).toBe(true);

    const argv = recorded<string[]>(r, "argv.json");
    expect(argv[0]).toBe("-p");
    expect(argv[argv.indexOf("--json-schema") + 1]).toBe('{"type":"object"}');
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    for (const flag of ["--strict-mcp-config", "--bare", "--no-session-persistence"]) expect(argv).toContain(flag);
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(argv.join("\n")).not.toContain("bypassPermissions");

    const env = recorded<Record<string, string>>(r, "env.json");
    const where = recorded<{ cwd: string; entries: string[] }>(r, "cwd.json");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test-key");
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(env.HOME ?? "", "claude-config"));
    expect(env.HOME).not.toBe(r.home);
    for (const name of [...LEAKED, "EXTRA_OK"]) expect(env).not.toHaveProperty(name);
    expect(where.entries).toEqual(["claude-config"]);
    expect(existsSync(where.cwd)).toBe(false);
    expect(snapshot(r.home)).toEqual(before);
    expect(readFileSync(join(r.record, "stdin.txt"), "utf8")).toBe("p");
  });

  it("returns auth_missing without spawning when the key is unset or empty", async () => {
    for (const key of [undefined, ""]) {
      const r = rig();
      installFakeClaude(r, writeFixture(r, envelope({ structured_output: {} })));
      const outcome = await createReconciler(r.project, claudeConfig(), { ...r.env, ANTHROPIC_API_KEY: key }).run(request());
      expect(outcome).toMatchObject({ ok: false, code: "auth_missing", reason: "ANTHROPIC_API_KEY is not set for the reconciler" });
      expect(existsSync(join(r.record, "argv.json"))).toBe(false);
    }
  });

  it("rejects an envelope that shows tool use or a second turn", async () => {
    const cases: Record<string, unknown>[] = [
      { num_turns: 2, structured_output: { candidates: [] } },
      { permission_denials: [{ tool_name: "Bash" }], structured_output: { candidates: [] } },
      { usage: { server_tool_use: { web_search_requests: 1 } }, structured_output: { candidates: [] } },
    ];
    for (const extra of cases) {
      const r = rig();
      installFakeClaude(r, writeFixture(r, envelope(extra)));
      const outcome = await createReconciler(r.project, claudeConfig(), r.env).run(request());
      expect(outcome).toMatchObject({ ok: false, code: "tool_not_disabled" });
    }
  });

  it("passes stdout that is not an envelope through for extractModelJson to reject", async () => {
    const r = rig();
    installFakeClaude(r, writeFixture(r, "plain text, not json"));
    const outcome = await createReconciler(r.project, claudeConfig(), r.env).run(request());
    expect(outcome).toMatchObject({ ok: true, stdout: "plain text, not json" });
  });
});
