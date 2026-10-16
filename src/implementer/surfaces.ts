import { type AuditSurface, textSurface, treeSurface } from "../audit/canary-scan.js";

/**
 * The `worktree` surface of an implementer round: the exported head tree (what the commits hold) and the whole container
 * capture (what the container held at the end, including files under /tmp and /agent that no commit contains). The audit
 * reads both, so a canary left in an uncommitted file is found the same way as one that was committed. The surface is
 * incomplete when the capture was cut short or the tree walk hit a limit: an incomplete surface makes the scan `not_run`,
 * which fails closed (spec §5.6).
 */
export function workspaceSurface(input: {
  treeDir: string;
  capture: { bytes: Buffer; complete: boolean };
}): AuditSurface {
  const tree = treeSurface(input.treeDir);
  return {
    kind: "worktree",
    async *read() {
      yield* tree.read();
      yield Buffer.from([0]);
      yield input.capture.bytes;
    },
    incomplete: () => !input.capture.complete || tree.incomplete(),
    symlinksSkipped: () => tree.symlinksSkipped(),
  };
}

/**
 * The redacted session log. `truncated` is true when the log was cut at the configured size, so the part that was dropped
 * was never searched and the surface says so.
 */
export function implementerLogSurface(log: string, options: { truncated?: boolean } = {}): AuditSurface {
  const surface = textSurface("implementer_log", log);
  return options.truncated === true ? { ...surface, incomplete: () => true } : surface;
}

/** The prompt text and the settings text, joined with a NUL byte so a canary cannot straddle two of them. */
export function promptSurface(texts: readonly string[]): AuditSurface {
  return textSurface("prompt", texts.join("\0"));
}
