import type { ContainerRuntime } from "../container/runtime.js";
import { type ImplementerSession, type SessionOutcome, failureCodeOf, limitsValid, outputOf } from "./session.js";

export interface StubScript {
  /** A constant argv the test supplies; it runs in `/work` of the container, as the model's edits would. */
  argv: readonly string[];
  stdin?: string;
}

/**
 * A session whose "model" is a canned script, for the offline tests (spec §9): the same container, workspace, bundle
 * and import as a real run, with no vendor client and no key. It never receives a secret, reports no cost, and ignores the
 * prompt, so a station test proves the plumbing and cannot be mistaken for evidence about a model.
 */
export function createStubSession(deps: { runtime: ContainerRuntime; script: StubScript }): ImplementerSession {
  return {
    id: "stub:script",
    vendor: "stub",
    model: null,
    async run(container, request): Promise<SessionOutcome> {
      const started = performance.now();
      const elapsed = (): number => Math.round(performance.now() - started);
      if (!limitsValid(request) || deps.script.argv.length === 0) {
        return { ok: false, code: "misconfigured", log: "", credential_hits: 0, durationMs: elapsed() };
      }
      const result = await deps.runtime.exec(container, {
        argv: deps.script.argv,
        ...(deps.script.stdin === undefined ? {} : { stdin: deps.script.stdin }),
        workdir: "/work",
        timeoutMs: request.timeoutMs,
        maxOutputBytes: request.maxOutputBytes,
      });
      const { stdout, stderr } = outputOf(result);
      const log = stderr === "" ? stdout : `${stdout}\n[stderr]\n${stderr}`;
      const code = failureCodeOf(result);
      if (code !== null) return { ok: false, code, log, credential_hits: 0, durationMs: elapsed() };
      return { ok: true, log, credential_hits: 0, notes: null, cost_micro_usd: null, durationMs: elapsed() };
    },
  };
}
