import type { ProcessResult } from "../adapters/process-group.js";
import type { ContainerHandle } from "../container/runtime.js";

/** Closed: a failed session leaves one of these and its redacted log, never text the container or the daemon printed (spec §4.6). */
export type ImplementerFailureCode = "timeout" | "spawn_failed" | "nonzero_exit" | "output_limit" | "misconfigured";

export interface SessionRequest {
  prompt: string;
  /** The settings text OMF writes into the container before the run. */
  settings: string;
  timeoutMs: number;
  maxOutputBytes: number;
  model: string | null;
  maxBudgetUsd: number | null;
}

/**
 * `log` is already redacted. The adapter scans the raw log first and returns only the hit count: it never blocks on a hit,
 * because the verbose log of a benign `env` or `printenv` call is not a leak. Blocking happens on what could be published.
 */
export type SessionOutcome =
  | {
      ok: true;
      log: string;
      credential_hits: number;
      notes: string | null;
      cost_micro_usd: number | null;
      durationMs: number;
    }
  | { ok: false; code: ImplementerFailureCode; log: string; credential_hits: number; durationMs: number };

/** OMF's own statement about the session; `vendor` and `model` are what the ledger records. Beside `AgentSession`, which stays the author's. */
export interface ImplementerSession {
  readonly id: string;
  readonly vendor: "claude" | "stub";
  readonly model: string | null;
  run(container: ContainerHandle, request: SessionRequest): Promise<SessionOutcome>;
}

/** null for a clean exit, else the closed code of the way the exec ended. */
export function failureCodeOf(result: ProcessResult): ImplementerFailureCode | null {
  switch (result.kind) {
    case "error":
      return "spawn_failed";
    case "timeout":
      return "timeout";
    case "output_limit":
      return "output_limit";
    case "exited":
      return result.status === 0 ? null : "nonzero_exit";
  }
}

/** What the exec printed; empty for a spawn error, whose message is never passed on. */
export function outputOf(result: ProcessResult): { stdout: string; stderr: string } {
  return result.kind === "error" ? { stdout: "", stderr: "" } : { stdout: result.stdout, stderr: result.stderr };
}

/** A run without a positive timeout and output cap is misconfigured before anything is executed. */
export function limitsValid(request: Pick<SessionRequest, "timeoutMs" | "maxOutputBytes">): boolean {
  return (
    Number.isFinite(request.timeoutMs) &&
    request.timeoutMs >= 1 &&
    Number.isInteger(request.maxOutputBytes) &&
    request.maxOutputBytes >= 1
  );
}
