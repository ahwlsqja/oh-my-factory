import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runProcessGroup } from "../adapters/process-group.js";
import { MAX_AUTHOR_OUTPUT_BYTES } from "../scenario/types.js";
import type { AuthorFailureCode, AuthorIsolation } from "../scenario/types.js";
import type { SealInputs } from "./prompt.js";

export interface AuthorRequest {
  prompt: string;
  /** The closed object `buildSealPrompt` turned into `prompt`. The container author writes these into files; the command author ignores them. */
  inputs: SealInputs;
  timeoutMs: number;
}

export type AuthorOutcome =
  | { ok: true; output: string; durationMs: number }
  | { ok: false; code: AuthorFailureCode; durationMs: number };

/** How long `runSealStage` waits for an author when the caller names no limit. */
export const DEFAULT_AUTHOR_TIMEOUT_MS = 300_000;

/**
 * The port implemented with a container session (spec §5.3). `vendor`, `model` and `isolation` are OMF's own
 * statement about the session, not the author's: they are what `runSealStage` stamps into the ledger and the
 * scenario files. Only a failure code leaves a failed run, never text the author or its stderr printed (spec §4.6).
 */
export interface AgentSession {
  readonly id: string;
  readonly vendor: string;
  readonly model: string;
  readonly isolation: AuthorIsolation;
  run(request: AuthorRequest): Promise<AuthorOutcome>;
}

export interface CommandAuthorConfig {
  command: readonly string[];
  /** Caps the request's own limit; the shorter of the two applies. */
  timeoutMs?: number;
  /** Names copied from the caller's environment. Nothing else is inherited. */
  envPassthrough?: readonly string[];
}

/**
 * The whole environment of the child: the named passthrough first (so it can never replace PATH or HOME), then PATH,
 * a scratch HOME and the C locale. A GITHUB_TOKEN, an API key or OMF_HOME in the caller's environment does not reach
 * the author, and the author is never told where the vault is.
 */
function authorEnv(config: CommandAuthorConfig, scratch: string, realEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of config.envPassthrough ?? []) {
    const value = realEnv[name];
    if (value !== undefined) env[name] = value;
  }
  env.PATH = realEnv.PATH ?? "/usr/bin:/bin";
  env.HOME = scratch;
  env.LC_ALL = "C";
  return env;
}

/**
 * An author that is a host process: the prompt goes on stdin, stdout is the output, there is no shell. It is labelled
 * `host_command`: it is not sealed from anything the OS user can reach, and the stage result says `stored`,
 * not `sealed`. One scratch directory per run is cwd and HOME, and is removed in `finally`.
 */
export function createCommandAuthor(
  config: CommandAuthorConfig,
  realEnv: NodeJS.ProcessEnv = process.env,
): AgentSession {
  const label = config.command
    .slice(0, 2)
    .map((part) => basename(part))
    .join("+");
  return {
    id: `command:${label}`,
    vendor: "command",
    model: "stub",
    isolation: "host_command",
    async run(request: AuthorRequest): Promise<AuthorOutcome> {
      const started = performance.now();
      const elapsed = (): number => Math.round(performance.now() - started);
      const fail = (code: AuthorFailureCode): AuthorOutcome => ({ ok: false, code, durationMs: elapsed() });
      const timeoutMs = Math.min(request.timeoutMs, config.timeoutMs ?? request.timeoutMs);
      if (config.command.length === 0 || !Number.isFinite(timeoutMs) || timeoutMs < 1) return fail("misconfigured");

      const scratch = mkdtempSync(join(tmpdir(), "omf-author-"));
      try {
        const result = await runProcessGroup(config.command, {
          cwd: scratch,
          env: authorEnv(config, scratch, realEnv),
          stdin: request.prompt,
          timeoutMs,
          maxOutputBytes: MAX_AUTHOR_OUTPUT_BYTES,
        });
        if (result.kind === "error") return fail("spawn_failed");
        if (result.kind === "timeout") return fail("timeout");
        if (result.kind === "output_limit") return fail("output_limit");
        if (result.status !== 0) return fail("nonzero_exit");
        if (result.stdout.trim() === "") return fail("no_output");
        return { ok: true, output: result.stdout, durationMs: elapsed() };
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  };
}
