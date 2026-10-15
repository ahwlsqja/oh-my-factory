import { describe, expect, it } from "vitest";
import { RuntimeError } from "../../src/container/runtime.js";
import { claudeArgv } from "../../src/implementer/claude-argv.js";
import {
  CLAUDE_SETTINGS_PATH,
  NOTES_MAX_CHARS,
  WRITE_SETTINGS_ARGV,
  createClaudeSession,
  parseClaudeLog,
} from "../../src/implementer/claude-session.js";
import { type Credential, readCredential } from "../../src/implementer/credential.js";
import type { SessionRequest } from "../../src/implementer/session.js";
import { HANDLE, exited, scriptedExec } from "../helpers/scripted-exec-runtime.js";

/** Not shaped like any vendor key; the quote and backslash make the JSON-escaped form differ from the plain one. */
const KEY = 'omf-test-key-"quoted"\\tail-0123456789';
const ESCAPED_KEY = JSON.stringify(KEY).slice(1, -1);

function credentialOf(value: string): Credential {
  const credential = readCredential("claude", { OMF_IMPLEMENTER_API_KEY: value });
  if (credential === null) throw new Error("the test key was rejected by readCredential");
  return credential;
}

const REQUEST: SessionRequest = {
  prompt: "PROMPT-TEXT",
  settings: '{"permissions":{"deny":[]}}\n',
  timeoutMs: 60_000,
  maxOutputBytes: 1_000_000,
  model: "claude-sonnet-5-5",
  maxBudgetUsd: 3,
};

const RESULT_LINE = (extra: Record<string, unknown>) =>
  JSON.stringify({ type: "result", subtype: "success", ...extra });

describe("parseClaudeLog", () => {
  it("takes the last result line: cost to integer micro-USD and the final text", () => {
    const log = [
      JSON.stringify({ type: "assistant", message: "working" }),
      RESULT_LINE({ total_cost_usd: 9, result: "first" }),
      "not json at all",
      RESULT_LINE({ total_cost_usd: 0.123456, result: "final answer" }),
      JSON.stringify({ type: "system", note: "after" }),
    ].join("\n");
    expect(parseClaudeLog(log)).toEqual({ cost_micro_usd: 123456, notes: "final answer" });
  });

  it("gives a null cost for a missing, negative, non-finite, non-numeric or oversize cost", () => {
    for (const cost of [undefined, -0.01, "0.5", null, 1e300]) {
      expect(parseClaudeLog(RESULT_LINE({ total_cost_usd: cost, result: "x" })).cost_micro_usd).toBeNull();
    }
    expect(parseClaudeLog('{"type":"result","total_cost_usd":1e999}').cost_micro_usd).toBeNull();
    expect(parseClaudeLog(RESULT_LINE({ total_cost_usd: 0, result: "x" })).cost_micro_usd).toBe(0);
  });

  it("gives nulls for a log with no result line, and caps the notes", () => {
    expect(parseClaudeLog("")).toEqual({ cost_micro_usd: null, notes: null });
    expect(parseClaudeLog(JSON.stringify({ type: "assistant", result: "decoy" }))).toEqual({
      cost_micro_usd: null,
      notes: null,
    });
    const long = parseClaudeLog(RESULT_LINE({ total_cost_usd: 1, result: "é".repeat(NOTES_MAX_CHARS + 50) }));
    expect(long.notes).toBe("é".repeat(NOTES_MAX_CHARS));
  });
});

describe("createClaudeSession", () => {
  const credential = credentialOf(KEY);

  it("writes the settings into /agent first, then runs claude with the prompt on stdin and the credential as a handle", async () => {
    const stdout = `${RESULT_LINE({ total_cost_usd: 0.5, result: "done" })}\n`;
    const { runtime, calls } = scriptedExec([exited(0), exited(0, stdout)]);
    const session = createClaudeSession({ runtime, credential, model: "claude-sonnet-5-5" });
    expect(session).toMatchObject({ id: "claude:claude-sonnet-5-5", vendor: "claude", model: "claude-sonnet-5-5" });

    const outcome = await session.run(HANDLE, REQUEST);

    expect(outcome).toMatchObject({ ok: true, credential_hits: 0, notes: "done", cost_micro_usd: 500000 });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ argv: WRITE_SETTINGS_ARGV, stdin: REQUEST.settings });
    expect(calls[0]?.secret).toBeUndefined();
    expect(WRITE_SETTINGS_ARGV.join(" ")).toContain(CLAUDE_SETTINGS_PATH);
    expect(calls[1]).toMatchObject({
      argv: claudeArgv({ model: "claude-sonnet-5-5", maxBudgetUsd: 3 }),
      stdin: REQUEST.prompt,
      workdir: "/work",
      timeoutMs: REQUEST.timeoutMs,
      maxOutputBytes: REQUEST.maxOutputBytes,
    });
    // The secret travels as the handle itself; the exec spec holds no value anywhere else.
    expect(calls[1]?.secret).toBe(credential);
    expect(calls[1]?.secret?.name).toBe("ANTHROPIC_API_KEY");
    expect(calls[1]?.env).toBeUndefined();
    for (const call of calls) {
      expect(JSON.stringify(call.argv)).not.toContain(KEY);
      expect(JSON.stringify(call.argv)).not.toContain(REQUEST.prompt);
    }
  });

  it("counts key hits in the raw log, redacts both spellings, and still completes", async () => {
    // What a benign `env` call leaves in a verbose log: the key plain in stderr, JSON-escaped in the stream.
    const stdout = [
      JSON.stringify({ type: "user", message: `ANTHROPIC_API_KEY=${KEY}` }),
      RESULT_LINE({ total_cost_usd: 0.25, result: `the key is ${KEY}` }),
    ].join("\n");
    const { runtime } = scriptedExec([exited(0), exited(0, stdout, `warning ${KEY}`)]);
    const outcome = await createClaudeSession({ runtime, credential, model: "claude-sonnet-5-5" }).run(HANDLE, REQUEST);

    expect(outcome.ok).toBe(true);
    expect(outcome.credential_hits).toBe(3);
    expect(outcome.log).not.toContain(KEY);
    expect(outcome.log).not.toContain(ESCAPED_KEY);
    expect(outcome.log).toContain("[redacted]");
    if (outcome.ok) {
      expect(outcome.notes).toBe("the key is [redacted]");
      expect(outcome.cost_micro_usd).toBe(250000);
    }
  });

  it.each([
    ["timeout", { kind: "timeout", stdout: `partial ${KEY}`, stderr: "" } as const],
    ["output_limit", { kind: "output_limit", stdout: "", stderr: "" } as const],
    ["spawn_failed", { kind: "error", code: "ENOENT", message: "docker missing" } as const],
    ["nonzero_exit", exited(3, "out", "err")],
    ["nonzero_exit", exited(null)],
  ])("maps %s to its closed code and still returns a redacted log", async (code, answer) => {
    const { runtime } = scriptedExec([exited(0), answer]);
    const outcome = await createClaudeSession({ runtime, credential, model: "claude-sonnet-5-5" }).run(HANDLE, REQUEST);
    expect(outcome).toMatchObject({ ok: false, code });
    expect(outcome.log).not.toContain(KEY);
    if (answer.kind === "timeout") expect(outcome.credential_hits).toBe(1);
  });

  it.each([
    ["timeout", "plain", KEY.slice(0, -1)],
    ["output_limit", "plain", KEY.slice(0, -1)],
    ["timeout", "escaped", ESCAPED_KEY.slice(0, -1)],
    ["output_limit", "escaped", ESCAPED_KEY.slice(0, -1)],
    ["output_limit", "short", KEY.slice(0, 1)],
  ] as const)(
    "leaves no key prefix in the log of a cut %s stream ending in a %s partial key",
    async (kind, _form, tail) => {
      for (const stream of ["stdout", "stderr"] as const) {
        const answer = { kind, stdout: "", stderr: "", [stream]: `output ${tail}` } as const;
        const { runtime } = scriptedExec([exited(0), answer]);
        const outcome = await createClaudeSession({ runtime, credential, model: "claude-sonnet-5-5" }).run(
          HANDLE,
          REQUEST,
        );
        expect(outcome.log).not.toContain(KEY.slice(0, 8));
        expect(outcome.log).not.toContain(ESCAPED_KEY.slice(0, 8));
        expect(outcome.log).toContain("[redacted]");
      }
    },
  );

  it("is spawn_failed when the settings cannot be written or the runtime refuses, and never runs claude then", async () => {
    const failedWrite = scriptedExec([exited(1)]);
    const first = await createClaudeSession({ ...failedWrite, credential, model: "claude-sonnet-5-5" }).run(
      HANDLE,
      REQUEST,
    );
    expect(first).toMatchObject({ ok: false, code: "spawn_failed", log: "", credential_hits: 0 });
    expect(failedWrite.calls).toHaveLength(1);

    const refused = scriptedExec([exited(0), new RuntimeError("docker_failed", "boom")]);
    const second = await createClaudeSession({ ...refused, credential, model: "claude-sonnet-5-5" }).run(
      HANDLE,
      REQUEST,
    );
    expect(second).toMatchObject({ ok: false, code: "spawn_failed" });
  });

  it("is misconfigured, with no exec at all, for bad limits, an empty prompt, a model that differs or a bad budget", async () => {
    const bad: SessionRequest[] = [
      { ...REQUEST, timeoutMs: 0 },
      { ...REQUEST, maxOutputBytes: 0 },
      { ...REQUEST, prompt: "" },
      { ...REQUEST, settings: "" },
      { ...REQUEST, model: "another-model" },
      { ...REQUEST, maxBudgetUsd: 0 },
    ];
    for (const request of bad) {
      const { runtime, calls } = scriptedExec([]);
      const outcome = await createClaudeSession({ runtime, credential, model: "claude-sonnet-5-5" }).run(
        HANDLE,
        request,
      );
      expect(outcome).toMatchObject({ ok: false, code: "misconfigured", credential_hits: 0 });
      expect(calls).toHaveLength(0);
    }
  });
});
