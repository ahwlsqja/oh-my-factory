import { execFileSync } from "node:child_process";
import { chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Real locations of the utilities the stub body calls, so a stub-only PATH can still run them. */
function realUtility(name: string): string {
  return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
}

/**
 * Shell body that writes where a real agent CLI writes even for `--version`: under $HOME, under
 * CODEX_HOME / CLAUDE_CONFIG_DIR when set, and ~/.claude.json. Spec §11 rule 1 forbids any of it
 * reaching the caller's home.
 */
const POLLUTE =
  'mkdir -p "$HOME/.codex/tmp" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.claude" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" ' +
  '&& touch "$HOME/.codex/tmp/x" "${CODEX_HOME:-$HOME/.codex}/y" "$HOME/.claude/x" ' +
  '"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/y" "$HOME/.claude.json"';

/**
 * Writes fake `claude` and `codex` CLIs into `dir` that pollute their home and print a version line.
 * Also links `mkdir` and `touch` into `dir`, so the stubs still run when PATH holds only `dir`.
 */
export function writePollutingAgentStubs(dir: string): void {
  for (const name of ["mkdir", "touch"]) symlinkSync(realUtility(name), join(dir, name));
  const stubs: Array<[string, string]> = [
    ["claude", "2.1.0 (Claude Code)"],
    ["codex", "codex-cli 0.160.1"],
  ];
  for (const [name, version] of stubs) {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${POLLUTE} || exit 1\necho "${version}"\nexit 0\n`);
    chmodSync(path, 0o755);
  }
}
