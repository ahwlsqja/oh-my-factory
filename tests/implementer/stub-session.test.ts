import { describe, expect, it } from "vitest";
import { createStubSession } from "../../src/implementer/stub-session.js";
import type { SessionRequest } from "../../src/implementer/session.js";
import { HANDLE, exited, scriptedExec } from "../helpers/scripted-exec-runtime.js";

const REQUEST: SessionRequest = {
  prompt: "IGNORED-BY-THE-SCRIPT",
  settings: "{}",
  timeoutMs: 5_000,
  maxOutputBytes: 10_000,
  model: null,
  maxBudgetUsd: null,
};
const SCRIPT = { argv: ["sh", "-c", "echo patched"], stdin: "canned input" } as const;

describe("createStubSession", () => {
  it("runs exactly the canned script in /work, with no secret, and reports a stub with no cost", async () => {
    const { runtime, calls } = scriptedExec([exited(0, "patched\n", "note")]);
    const session = createStubSession({ runtime, script: SCRIPT });
    expect(session).toMatchObject({ id: "stub:script", vendor: "stub", model: null });

    const outcome = await session.run(HANDLE, REQUEST);

    expect(outcome).toMatchObject({ ok: true, credential_hits: 0, notes: null, cost_micro_usd: null });
    expect(outcome.log).toBe("patched\n\n[stderr]\nnote");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      argv: SCRIPT.argv,
      stdin: "canned input",
      workdir: "/work",
      timeoutMs: 5_000,
      maxOutputBytes: 10_000,
    });
    expect(calls[0]?.secret).toBeUndefined();
    // The prompt is the real session's input, not the script's.
    expect(JSON.stringify(calls[0])).not.toContain(REQUEST.prompt);
  });

  it.each([
    ["nonzero_exit", exited(1)],
    ["timeout", { kind: "timeout", stdout: "", stderr: "" } as const],
    ["output_limit", { kind: "output_limit", stdout: "", stderr: "" } as const],
    ["spawn_failed", { kind: "error", code: null, message: "x" } as const],
  ])("maps %s to its closed code", async (code, answer) => {
    const { runtime } = scriptedExec([answer]);
    const outcome = await createStubSession({ runtime, script: SCRIPT }).run(HANDLE, REQUEST);
    expect(outcome).toMatchObject({ ok: false, code, credential_hits: 0 });
  });

  it("is misconfigured, with no exec, for a run without positive limits or for an empty script", async () => {
    for (const [request, script] of [
      [{ ...REQUEST, timeoutMs: 0 }, SCRIPT],
      [{ ...REQUEST, maxOutputBytes: 0 }, SCRIPT],
      [REQUEST, { argv: [] }],
    ] as const) {
      const { runtime, calls } = scriptedExec([]);
      const outcome = await createStubSession({ runtime, script }).run(HANDLE, request);
      expect(outcome).toMatchObject({ ok: false, code: "misconfigured" });
      expect(calls).toHaveLength(0);
    }
  });
});
