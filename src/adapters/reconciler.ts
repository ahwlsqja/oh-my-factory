import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ConfigError, type ReconcilerConfig, type ReconcilerKind } from "../core/config.js";
import { type ProcessResult, runProcessGroup } from "./process-group.js";

/** Why a reconciler run produced no usable output. Fixed set: the ledger stores the code, never model or stderr text (spec §4.6). */
export type ReconcileFailureCode =
  | "timeout"
  | "spawn_failed"
  | "nonzero_exit"
  | "no_output"
  | "output_limit"
  | "auth_missing"
  | "misconfigured"
  | "tool_not_disabled";

export type ReconcileOutcome =
  | { ok: true; stdout: string; durationMs: number }
  | { ok: false; code: ReconcileFailureCode; reason: string; durationMs: number };

export interface ReconcileRequest {
  prompt: string;
  outputSchema: object;
  timeoutMs: number;
}

/** A model adapter. Every test uses the `command` kind with a stub process, so the loop runs without a service (spec §4.4). */
export interface Reconciler {
  readonly id: string;
  readonly isolation: "host-tool-less";
  run(request: ReconcileRequest): Promise<ReconcileOutcome>;
}

/** One fixed sentence per code. Stderr and stdout of the child never appear in an outcome. */
export const FAILURE_REASONS: Readonly<Record<ReconcileFailureCode, string>> = {
  timeout: "the reconciler did not answer within the time limit",
  spawn_failed: "the reconciler command could not be started",
  nonzero_exit: "the reconciler exited with an error",
  no_output: "the reconciler printed nothing",
  output_limit: "the reconciler printed more than the output limit",
  auth_missing: "ANTHROPIC_API_KEY is not set for the reconciler",
  misconfigured: "the reconciler time limit is not a positive number",
  tool_not_disabled: "the claude run reported tool use or more than one turn",
};

/** Output cap for one run. A reconcile answer is a few KB; the cap only stops a runaway process. */
export const RECONCILE_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Argv for `claude` after the program name (spec §4.4 step 4, §2). The prompt is NOT in argv: it
 * goes on stdin, so a prompt that starts with `-` or contains YAML front matter cannot be mis-parsed as a
 * flag. `--tools ""` removes the built-in tools; `--strict-mcp-config` ignores every MCP configuration
 * not passed explicitly (none is); `--json-schema` is deliberately absent, because Claude Code implements it
 * with a synthetic tool call that adds turns and would defeat the one-turn check in `usedTools`; the answer is
 * parsed from `result` and validated against the schema by OMF itself; `--bare` skips hooks, plugins, CLAUDE.md discovery and keychain reads
 * and makes ANTHROPIC_API_KEY the only credential. Permission-bypass flags are never added: they are
 * for containers only (spec §7).
 */
export function buildClaudeArgs(config: ReconcilerConfig): string[] {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--tools",
    "",
    "--strict-mcp-config",
    "--bare",
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
  ];
  if (config.model !== null) args.push("--model", config.model);
  if (config.max_budget_usd !== null) args.push("--max-budget-usd", String(config.max_budget_usd));
  return args;
}

/**
 * The whole environment of the child. Nothing is inherited: a GITHUB_TOKEN, AWS_* or INFISICAL_* variable
 * in the caller's environment must not reach a process that talks to a model (F6). HOME and the claude
 * config dir sit inside the per-run scratch dir, so the user's `~/.claude` is neither read nor written.
 * Names in `env_passthrough` (command kind only) are copied first so they can never replace HOME or PATH.
 */
export function reconcilerEnv(
  config: ReconcilerConfig,
  scratch: string,
  realEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (config.kind === "command") {
    for (const name of config.env_passthrough) {
      const value = realEnv[name];
      if (value !== undefined) env[name] = value;
    }
  }
  env.PATH = realEnv.PATH ?? "/usr/bin:/bin";
  env.HOME = scratch;
  env.LC_ALL = "C";
  if (config.kind === "claude") {
    env.CLAUDE_CONFIG_DIR = `${scratch}/claude-config`;
    const key = realEnv.ANTHROPIC_API_KEY;
    if (key !== undefined && key !== "") env.ANTHROPIC_API_KEY = key;
  }
  return env;
}

export type ParseErrorCode = "not_json" | "envelope_shape";

/**
 * The message is the code and nothing else: JSON.parse messages quote the input, and the input is model
 * text that must not reach the ledger (§2 item 7).
 */
export class ReconcileParseError extends Error {
  constructor(readonly code: ParseErrorCode) {
    super(code);
    this.name = "ReconcileParseError";
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ReconcileParseError("not_json");
  }
}

const FENCE = /^```[A-Za-z]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pulls the model's JSON out of stdout. `claude --output-format json` prints one envelope object; the
 * answer is in `result` as bare or fenced JSON (`structured_output` is read if present). A
 * `command` prints the JSON itself. The value is returned as unvalidated data: Task 9 validates it
 * against `reconcile-output.schema.json` (spec §4.4 step 4: the model's output is parsed, never trusted).
 */
export function extractModelJson(kind: ReconcilerKind, stdout: string): unknown {
  const parsed = parseJson(stdout.trim());
  if (kind === "command") return parsed;
  if (!isRecord(parsed) || parsed.is_error === true) throw new ReconcileParseError("envelope_shape");
  if (parsed.structured_output !== undefined) return parsed.structured_output;
  if (typeof parsed.result !== "string") throw new ReconcileParseError("envelope_shape");
  const text = parsed.result.trim();
  const fenced = FENCE.exec(text);
  return parseJson(fenced?.[1] ?? text);
}

/**
 * True when a claude envelope shows the run did more than answer once: more than one turn, a tool call
 * that permissions denied, or a server-side tool. With `--tools ""` none can happen, so seeing one means
 * the flag did not take effect and the answer must not be trusted (spec §4.6).
 */
export function usedTools(envelope: unknown): boolean {
  if (!isRecord(envelope)) return false;
  if (typeof envelope.num_turns === "number" && envelope.num_turns > 1) return true;
  if (Array.isArray(envelope.permission_denials) && envelope.permission_denials.length > 0) return true;
  const usage = envelope.usage;
  if (isRecord(usage) && isRecord(usage.server_tool_use)) {
    return Object.values(usage.server_tool_use).some((count) => typeof count === "number" && count > 0);
  }
  return false;
}

/** How a process that did not exit maps to a failure code. */
const KIND_CODE = { error: "spawn_failed", timeout: "timeout", output_limit: "output_limit" } as const;

/** Parses stdout as a claude envelope for the tool-use check; text that is not JSON is left to extractModelJson. */
function envelopeOf(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

class ProcessReconciler implements Reconciler {
  readonly isolation = "host-tool-less" as const;

  constructor(
    readonly id: string,
    private readonly config: ReconcilerConfig,
    private readonly realEnv: NodeJS.ProcessEnv,
  ) {}

  async run(request: ReconcileRequest): Promise<ReconcileOutcome> {
    const started = performance.now();
    const fail = (code: ReconcileFailureCode): ReconcileOutcome => ({
      ok: false,
      code,
      reason: FAILURE_REASONS[code],
      durationMs: Math.round(performance.now() - started),
    });
    if (!Number.isFinite(request.timeoutMs) || request.timeoutMs < 1) return fail("misconfigured");
    const isClaude = this.config.kind === "claude";
    // No key means no spawn: a keyless claude would fall back to whatever login the machine has.
    if (isClaude && (this.realEnv.ANTHROPIC_API_KEY ?? "") === "") return fail("auth_missing");

    // One scratch dir per run is cwd, HOME and the parent of claude's config dir. It is the only
    // writable place the model process knows, and it never holds anything of the user's.
    const scratch = mkdtempSync(join(tmpdir(), "omf-reconcile-"));
    try {
      if (isClaude) mkdirSync(join(scratch, "claude-config"), { mode: 0o700 });
      const argv = isClaude ? ["claude", ...buildClaudeArgs(this.config)] : [...(this.config.command ?? [])];
      const result = await runProcessGroup(argv, {
        cwd: scratch,
        env: reconcilerEnv(this.config, scratch, this.realEnv),
        stdin: request.prompt,
        timeoutMs: request.timeoutMs,
        maxOutputBytes: RECONCILE_MAX_OUTPUT_BYTES,
      });
      return this.judge(result, fail, Math.round(performance.now() - started));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  private judge(
    result: ProcessResult,
    fail: (code: ReconcileFailureCode) => ReconcileOutcome,
    durationMs: number,
  ): ReconcileOutcome {
    if (result.kind !== "exited") return fail(KIND_CODE[result.kind]);
    if (result.status !== 0) return fail("nonzero_exit");
    if (result.stdout.trim() === "") return fail("no_output");
    if (this.config.kind === "claude" && usedTools(envelopeOf(result.stdout))) return fail("tool_not_disabled");
    return { ok: true, stdout: result.stdout, durationMs };
  }
}

/**
 * Builds the adapter for `[reconciler]` (§2). `kind = "claude"` runs the `claude` CLI on PATH;
 * `kind = "command"` runs the configured argv, which is how tests and `examples/hello-goal` stub the
 * model. `projectDir` is accepted so every adapter is built from the same location, but a run touches
 * only its scratch dir and never reads project state. `realEnv` is the caller's environment, of which
 * only the names `reconcilerEnv` allows are used.
 */
export function createReconciler(
  _projectDir: string,
  config: ReconcilerConfig,
  realEnv: NodeJS.ProcessEnv = process.env,
): Reconciler {
  if (config.kind === "command") {
    if (config.command === null || config.command.length === 0) {
      throw new ConfigError('[reconciler] kind "command" needs a non-empty command');
    }
    return new ProcessReconciler(
      `command:${config.command
        .slice(0, 2)
        .map((part) => basename(part))
        .join("+")}`,
      config,
      realEnv,
    );
  }
  return new ProcessReconciler("claude", config, realEnv);
}
