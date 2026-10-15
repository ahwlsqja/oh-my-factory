/**
 * The argv and settings of the Claude Code implementer session (spec §7). This is the only file under `src/` that names a
 * permission-bypass flag, and `claude-session.ts` is the only file that imports it: the flag is only ever handed to
 * `ContainerRuntime.exec`, never to a host process (`W-no-bypass-on-host`).
 */

/** Where OMF writes the settings inside the container: the tmpfs `/agent`, which is also `HOME`. */
export const CLAUDE_SETTINGS_PATH = "/agent/settings.json";

/** Safe only because the session runs in the measured L2 container; the container is the sandbox, not the prompt. */
export const BYPASS_FLAGS: readonly string[] = ["--dangerously-skip-permissions"];

export type ClaudeArgvErrorCode = "invalid_model" | "invalid_budget" | "invalid_glob";

/** The message is the code only, so no caller-supplied text reaches a log through an error. */
export class ClaudeArgvError extends Error {
  constructor(readonly code: ClaudeArgvErrorCode) {
    super(code);
    this.name = "ClaudeArgvError";
  }
}

/** Letters, digits and `._:-`, at most 80 characters, and never a leading `-`: argv has no `--` guard, so a model name must not read as a flag. */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

/**
 * Floors to a whole micro-dollar, so the cap passed to the client is never above the remaining item budget, and prints
 * the shortest decimal. A cap that floors to zero is refused rather than sent as "0", which the client may read as no cap.
 */
function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) throw new ClaudeArgvError("invalid_budget");
  const micro = Math.floor(usd * 1_000_000);
  if (micro < 1) throw new ClaudeArgvError("invalid_budget");
  return (micro / 1_000_000).toFixed(6).replace(/\.?0+$/, "");
}

/**
 * Argv of the session. `--settings` and `--setting-sources user` load only the OMF-written settings and the OMF-owned config
 * directory, so a `.claude/settings.json` in the repository is not read. No `--bare`: it would skip both. The prompt goes
 * on stdin, so text that starts with `-` cannot be read as a flag.
 */
export function claudeArgv(options: { model: string | null; maxBudgetUsd: number | null }): string[] {
  const argv = [
    "claude",
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--settings",
    CLAUDE_SETTINGS_PATH,
    "--setting-sources",
    "user",
    "--no-session-persistence",
    ...BYPASS_FLAGS,
  ];
  if (options.model !== null) {
    if (!MODEL_PATTERN.test(options.model)) throw new ClaudeArgvError("invalid_model");
    argv.push("--model", options.model);
  }
  if (options.maxBudgetUsd !== null) argv.push("--max-budget-usd", formatUsd(options.maxBudgetUsd));
  return argv;
}

/** A glob is a repository-relative path pattern: no absolute or home path, no `..`, nothing that ends the `Edit(...)` rule early. */
function isSafeGlob(glob: string): boolean {
  if (glob === "" || glob.length > 200) return false;
  if (glob.startsWith("/") || glob.startsWith("~")) return false;
  if (glob.split("/").includes("..")) return false;
  for (const ch of glob) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || ch === "(" || ch === ")" || ch === "\\") return false;
  }
  return true;
}

/**
 * The settings text OMF writes into the container: a best-effort deny list for edits of the test globs and nothing else
 * (no key, no mode, no host path). The classification of the diff after the fact is authoritative (`tests_edited` in the
 * audit); this only stops an honest session from trying.
 */
export function claudeSettings(input: { denyEditGlobs: readonly string[] }): string {
  for (const glob of input.denyEditGlobs) if (!isSafeGlob(glob)) throw new ClaudeArgvError("invalid_glob");
  const deny = [...new Set(input.denyEditGlobs)].sort().map((glob) => `Edit(${glob})`);
  return `${JSON.stringify({ permissions: { deny } }, null, 2)}\n`;
}
