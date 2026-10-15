import { type ContainerRuntime, RuntimeError } from "../container/runtime.js";
import { CLAUDE_SETTINGS_PATH, ClaudeArgvError, claudeArgv } from "./claude-argv.js";
import { type Credential, redact } from "./credential.js";
import {
  type ImplementerFailureCode,
  type ImplementerSession,
  type SessionOutcome,
  type SessionRequest,
  failureCodeOf,
  limitsValid,
  outputOf,
} from "./session.js";

// The station needs these two; re-exporting keeps this file the only importer of claude-argv.ts (`W-no-bypass-on-host`).
export { CLAUDE_SETTINGS_PATH, claudeSettings } from "./claude-argv.js";

const REDACTED = "[redacted]";

/** Final text kept from the result line; the station caps it again for evidence. Untrusted. */
export const NOTES_MAX_CHARS = 4000;

/** Constant, nothing interpolated: the settings text arrives on stdin. `umask 077` keeps it private inside the tmpfs. */
export const WRITE_SETTINGS_ARGV: readonly string[] = [
  "sh",
  "-c",
  `umask 077 && mkdir -p /agent/claude && cat > ${CLAUDE_SETTINGS_PATH}`,
];

const WORKDIR = "/work";
const SETTINGS_WRITE_TIMEOUT_MS = 30_000;
const SETTINGS_WRITE_MAX_OUTPUT_BYTES = 4096;

/** Whole micro-dollars, or null when the vendor client reported nothing usable (the item then counts as unverifiable spend). */
function microUsd(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const micro = Math.round(value * 1_000_000);
  return Number.isSafeInteger(micro) ? micro : null;
}

function notesOf(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  // Slice first so a huge string is not spread into an array; two code units per character is the worst case.
  return [...value.slice(0, 2 * NOTES_MAX_CHARS)].slice(0, NOTES_MAX_CHARS).join("");
}

/**
 * Reads the last `{"type":"result"}` line of the (already redacted) stream-json log. Only the client itself writes such a
 * line at the top level; text the implementer prints sits inside JSON strings of other event types, so it cannot forge one.
 */
export function parseClaudeLog(log: string): { cost_micro_usd: number | null; notes: string | null } {
  const lines = log.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = (lines[index] ?? "").trim();
    if (!line.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || (parsed as { type?: unknown }).type !== "result") continue;
    const record = parsed as Record<string, unknown>;
    return { cost_micro_usd: microUsd(record.total_cost_usd), notes: notesOf(record.result) };
  }
  return { cost_micro_usd: null, notes: null };
}

/**
 * Counts, then removes, the key in both spellings: stream-json escapes `"` and `\`, so a key holding either appears
 * in a different form than in stderr. The escaped form goes first because it can contain the plain one.
 */
function scrub(text: string, credential: Credential): { text: string; hits: number } {
  const plain = credential.reveal();
  const escaped = JSON.stringify(plain).slice(1, -1);
  let hits = 0;
  let out = text;
  if (escaped !== plain) {
    const parts = out.split(escaped);
    hits += parts.length - 1;
    out = parts.join(REDACTED);
  }
  hits += out.split(plain).length - 1;
  return { text: redact(out, credential), hits };
}

/** The request's model must be the one the session reports to the ledger, and the argv builder must accept the values. */
function sessionArgv(model: string | null, request: SessionRequest): string[] | null {
  if (!limitsValid(request) || request.prompt === "" || request.settings === "" || request.model !== model) return null;
  try {
    return claudeArgv({ model: request.model, maxBudgetUsd: request.maxBudgetUsd });
  } catch (err) {
    if (err instanceof ClaudeArgvError) return null;
    throw err;
  }
}

/**
 * Claude Code inside the implementer container (spec §7). Its only execution path is `ContainerRuntime.exec`: the settings
 * are written into the tmpfs, then `claude` runs with the prompt on stdin and the key as a `SecretHandle`, so the value
 * reaches the docker client's environment for that one exec and never an argv (M3-D3).
 */
export function createClaudeSession(deps: {
  runtime: ContainerRuntime;
  credential: Credential;
  model: string | null;
}): ImplementerSession {
  return {
    id: `claude:${deps.model ?? "default"}`,
    vendor: "claude",
    model: deps.model,
    async run(container, request): Promise<SessionOutcome> {
      const started = performance.now();
      const elapsed = (): number => Math.round(performance.now() - started);
      const fail = (code: ImplementerFailureCode, log = "", hits = 0): SessionOutcome => ({
        ok: false,
        code,
        log,
        credential_hits: hits,
        durationMs: elapsed(),
      });

      const argv = sessionArgv(deps.model, request);
      if (argv === null) return fail("misconfigured");

      let result: Awaited<ReturnType<ContainerRuntime["exec"]>>;
      try {
        const written = await deps.runtime.exec(container, {
          argv: WRITE_SETTINGS_ARGV,
          stdin: request.settings,
          timeoutMs: Math.min(request.timeoutMs, SETTINGS_WRITE_TIMEOUT_MS),
          maxOutputBytes: SETTINGS_WRITE_MAX_OUTPUT_BYTES,
        });
        if (failureCodeOf(written) !== null) return fail("spawn_failed");
        result = await deps.runtime.exec(container, {
          argv,
          stdin: request.prompt,
          workdir: WORKDIR,
          timeoutMs: request.timeoutMs,
          maxOutputBytes: request.maxOutputBytes,
          secret: deps.credential,
        });
      } catch (err) {
        if (err instanceof RuntimeError) return fail("spawn_failed");
        throw err;
      }

      const raw = outputOf(result);
      const stdout = scrub(raw.stdout, deps.credential);
      const stderr = scrub(raw.stderr, deps.credential);
      const log = stderr.text === "" ? stdout.text : `${stdout.text}\n[stderr]\n${stderr.text}`;
      const hits = stdout.hits + stderr.hits;
      const code = failureCodeOf(result);
      if (code !== null) return fail(code, log, hits);
      // Parsed from the redacted stdout only: stderr is the container's, and a result line there is not the client's.
      const { cost_micro_usd, notes } = parseClaudeLog(stdout.text);
      return { ok: true, log, credential_hits: hits, notes, cost_micro_usd, durationMs: elapsed() };
    },
  };
}
