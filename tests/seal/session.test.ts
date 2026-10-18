import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createCommandAuthor } from "../../src/seal/session.js";
import { SESSION_INPUTS } from "../helpers/seal-fixture.js";
import { makeTempDir } from "../helpers/tmp.js";

const STUB = fileURLToPath(new URL("../helpers/author-stub.mjs", import.meta.url));

function authorFor(
  record: string,
  mode: string,
  extra: { timeoutMs?: number; envPassthrough?: string[] } = {},
  realEnv: NodeJS.ProcessEnv = process.env,
) {
  return createCommandAuthor({ command: [process.execPath, STUB, mode, record], ...extra }, realEnv);
}

function recorded<T>(record: string, name: string): T {
  return JSON.parse(readFileSync(join(record, name), "utf8")) as T;
}

describe("createCommandAuthor", () => {
  it("labels the session as a host command and passes the prompt on stdin with a stripped environment", async () => {
    const record = makeTempDir("omf-rec-");
    const realEnv = {
      PATH: process.env.PATH,
      KEEP_ME: "1",
      SECRET_TOKEN: "s3cret",
      ANTHROPIC_API_KEY: "sk-x",
      OMF_HOME: "/real/omf",
    };
    const author = authorFor(record, "from_feedback", { envPassthrough: ["KEEP_ME"] }, realEnv);
    expect(author).toMatchObject({ vendor: "command", model: "stub", isolation: "host_command" });

    const prompt = "PROMPT-MARKER\n- unlinked decision: d-cache\n";
    const outcome = await author.run({ prompt, inputs: SESSION_INPUTS, timeoutMs: 20_000 });
    expect(outcome).toMatchObject({ ok: true });
    // from_feedback links the id the prompt named, once per split
    expect(outcome.ok && outcome.output.match(/^ {2}- d-cache$/gm)).toHaveLength(2);

    expect(readFileSync(join(record, "stdin.txt"), "utf8")).toBe(prompt);
    expect(recorded<string[]>(record, "argv.json").join(" ")).not.toContain("PROMPT-MARKER");
    const env = recorded<Record<string, string>>(record, "env.json");
    const where = recorded<{ cwd: string }>(record, "cwd.json");
    expect(env.KEEP_ME).toBe("1");
    expect(env.LC_ALL).toBe("C");
    expect(basename(env.HOME ?? "")).toMatch(/^omf-author-/);
    expect(where.cwd).toBe(join(realpathSync(dirname(env.HOME ?? "")), basename(env.HOME ?? "")));
    for (const name of ["SECRET_TOKEN", "ANTHROPIC_API_KEY", "OMF_HOME"]) expect(env).not.toHaveProperty(name);
    expect(existsSync(where.cwd), "the scratch directory is removed").toBe(false);
  });

  it("maps every way a run can end to one failure code", async () => {
    const cases: Array<[string, string]> = [
      ["exit3", "nonzero_exit"],
      ["empty", "no_output"],
      ["big", "output_limit"],
    ];
    for (const [mode, code] of cases) {
      const outcome = await authorFor(makeTempDir("omf-rec-"), mode).run({
        prompt: "p",
        inputs: SESSION_INPUTS,
        timeoutMs: 20_000,
      });
      expect(outcome, mode).toMatchObject({ ok: false, code });
    }
    // The author's own limit wins over a longer request: 300 ms, not 20 s.
    const slow = await authorFor(makeTempDir("omf-rec-"), "sleep", { timeoutMs: 300 }).run({
      prompt: "p",
      inputs: SESSION_INPUTS,
      timeoutMs: 20_000,
    });
    expect(slow).toMatchObject({ ok: false, code: "timeout" });
    const missing = await createCommandAuthor({ command: ["/nonexistent/omf-author"] }).run({
      prompt: "p",
      inputs: SESSION_INPUTS,
      timeoutMs: 20_000,
    });
    expect(missing).toMatchObject({ ok: false, code: "spawn_failed" });
  });

  it("is misconfigured with no command or no positive time limit, and never spawns", async () => {
    const record = makeTempDir("omf-rec-");
    expect(
      await createCommandAuthor({ command: [] }).run({ prompt: "p", inputs: SESSION_INPUTS, timeoutMs: 1000 }),
    ).toMatchObject({
      ok: false,
      code: "misconfigured",
    });
    expect(await authorFor(record, "empty").run({ prompt: "p", inputs: SESSION_INPUTS, timeoutMs: 0 })).toMatchObject({
      ok: false,
      code: "misconfigured",
    });
    expect(existsSync(join(record, "stdin.txt"))).toBe(false);
  });
});
