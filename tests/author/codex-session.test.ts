import { describe, expect, it } from "vitest";
import { ANSWER_SCHEMA_TEXT, OUTPUT_SUFFIX, codexArgv } from "../../src/author/codex-argv.js";
import { createContainerAuthor, parseAnswer } from "../../src/author/codex-session.js";
import { authorSessionCompletedEvent } from "../../src/author/events.js";
import { sha256Hex } from "../../src/core/canonical-json.js";
import { readCredential } from "../../src/implementer/credential.js";
import type { StageMeasurement } from "../../src/isolation/types.js";
import { type SealedPass, runSealStage } from "../../src/seal/seal.js";
import {
  AUTHOR_KEY,
  AUTHOR_PASS_ID,
  AUTHOR_WORK_ID,
  GOOD_ANSWER,
  YAML_TEXT,
  type AuthorScript,
  authorConfig,
  authorCredential,
  authorDeps,
  authorDouble,
  authorRequest,
} from "../helpers/author-container.js";
import { SESSION_INPUTS, authoredDoc, depsFor, sealFixture, stored } from "../helpers/seal-fixture.js";

// covers: S4.6.author-answer-closed
const stdinOf = (call: { stdin: Buffer | null } | undefined): string => call?.stdin?.toString("utf8") ?? "";

describe("parseAnswer", () => {
  it("takes exactly one non-empty string field", () => {
    expect(parseAnswer(GOOD_ANSWER)).toEqual({ ok: true, yaml: YAML_TEXT });
    for (const text of ["", "[]", '{"scenarios_yaml":" \\n"}', '{"scenarios_yaml":1}', '{"other":"x"}']) {
      expect(parseAnswer(text)).toEqual({ ok: false });
    }
  });
});

describe("createContainerAuthor: a good run", () => {
  it("measures first, feeds the container, runs Codex with the key, reads the answer, and removes the container", async () => {
    const double = authorDouble();
    const session = createContainerAuthor(authorDeps(double));
    expect(session).toMatchObject({
      id: "codex:gpt-5-codex",
      vendor: "codex",
      model: "gpt-5-codex",
      isolation: "container",
    });
    const request = authorRequest();

    expect(await session.run(request)).toMatchObject({ ok: true, output: YAML_TEXT });

    expect(double.execs.map((call) => call.argv[0])).toEqual(["sh", "tar", "tar", "codex", "cat"]);
    const verbs = double.fake.verbs();
    expect(verbs.indexOf("create")).toBeLessThan(verbs.indexOf("exec"));
    expect(Object.keys(double.fake.state.containers)).toEqual([]);

    const [intoIn, intoAgent] = double.extracted;
    expect(intoIn?.dest).toBe("/in");
    expect(intoIn?.items.map((item) => item.path).sort()).toEqual(["contract.json", "intent.md", "spec.md"]);
    const text = (path: string): string =>
      intoIn?.items.find((item) => item.path === path)?.data.toString("utf8") ?? "";
    expect(text("intent.md")).toBe(SESSION_INPUTS.intent);
    expect(JSON.parse(text("contract.json"))).toEqual(SESSION_INPUTS.contract);
    expect(intoAgent?.dest).toBe("/agent");
    expect(intoAgent?.items.map((item) => item.path).sort()).toEqual(["answer.schema.json", "codex/"]);
    expect(intoAgent?.items.find((item) => item.path === "answer.schema.json")?.data.toString("utf8")).toBe(
      ANSWER_SCHEMA_TEXT,
    );

    // The key rides on the Codex exec alone, only in the client's environment; stdin is the prompt plus the suffix.
    const carrying = double.execs.filter((call) => "CODEX_API_KEY" in call.env);
    expect(carrying).toHaveLength(1);
    expect(carrying[0]?.argv).toEqual(codexArgv({ model: "gpt-5-codex" }));
    expect(carrying[0]?.env.CODEX_API_KEY).toBe(AUTHOR_KEY);
    expect(stdinOf(carrying[0])).toBe(`${request.prompt}${OUTPUT_SUFFIX}`);
    expect(JSON.stringify(double.fake.state.calls)).not.toContain(AUTHOR_KEY);
  });

  it("hands the measurement and the facts out once; what Codex printed never leaves; the facts build a valid event", async () => {
    const double = authorDouble();
    const session = createContainerAuthor(authorDeps(double));
    const request = authorRequest();
    const outcome = await session.run(request);

    expect(JSON.stringify(outcome)).not.toContain("PRIVATE");
    expect(session.takeMeasurement()).toMatchObject({
      stage: "author",
      mode: "container",
      level: "L2",
      violations: [],
    });
    expect(session.takeMeasurement()).toBeNull();
    const facts = session.takeFacts();
    expect(facts).toMatchObject({
      pass_id: AUTHOR_PASS_ID,
      round: 1,
      vendor: "codex",
      model: "gpt-5-codex",
      outcome: "completed",
      input_sha256: sha256Hex(`${request.prompt}${OUTPUT_SUFFIX}`),
      violation_codes: [],
      answer_sha256: sha256Hex(GOOD_ANSWER),
      answer_bytes: Buffer.byteLength(GOOD_ANSWER),
      credential_hits: 0,
    });
    expect(facts?.input_sha256).not.toBe(sha256Hex(request.prompt));
    expect(JSON.stringify(facts)).not.toContain("PRIVATE");
    expect(session.takeFacts()).toBeNull();
    if (facts === null) throw new Error("no facts");
    expect(() => authorSessionCompletedEvent({ goal_id: "g-fast", work_id: AUTHOR_WORK_ID }, facts)).not.toThrow();
  });

  it("stamps codex-default and passes no -m when the config names no model", async () => {
    const double = authorDouble();
    const session = createContainerAuthor(authorDeps(double, { config: authorConfig(null) }));
    expect(session).toMatchObject({ id: "codex:default", model: "codex-default" });
    await session.run(authorRequest());
    expect(double.execs.find((call) => call.argv[0] === "codex")?.argv).not.toContain("-m");
    expect(session.takeFacts()?.model).toBe("codex-default");
  });

  it("uses the smaller of the request's timeout and the configured one", async () => {
    const config = authorConfig();
    const short = { ...config, author: { ...config.author, timeout_ms: 5_000 } };
    for (const [requested, expected] of [
      [60_000, 5_000],
      [1_000, 1_000],
    ] as const) {
      const double = authorDouble();
      await createContainerAuthor(authorDeps(double, { config: short })).run(authorRequest(requested));
      expect(double.runs.find((run) => run.argv.includes("codex"))?.timeoutMs).toBe(expected);
    }
  });
});

describe("createContainerAuthor: the caps", () => {
  it("passes the configured output cap to the Codex exec and records the caps in the facts", async () => {
    const config = authorConfig();
    const capped = { ...config, author: { ...config.author, max_output_bytes: 65_536, timeout_ms: 90_000 } };
    const double = authorDouble();
    const session = createContainerAuthor(authorDeps(double, { config: capped, callsBefore: 2 }));
    await session.run(authorRequest(300_000));
    expect(double.runs.find((run) => run.argv.includes("codex"))?.maxOutputBytes).toBe(65_536);
    expect(session.takeFacts()).toMatchObject({
      limit_timeout_ms: 90_000,
      limit_output_bytes: 65_536,
      limit_calls: config.author.max_calls,
      calls_before: 2,
      output_bytes: Buffer.byteLength("PRIVATE-STDOUT") + Buffer.byteLength("PRIVATE-STDERR"),
    });
  });

  it("defaults the caps and counts no earlier call", async () => {
    const session = createContainerAuthor(authorDeps(authorDouble()));
    await session.run(authorRequest());
    expect(session.takeFacts()).toMatchObject({
      limit_timeout_ms: 60_000,
      limit_output_bytes: 1024 * 1024,
      calls_before: 0,
    });
  });
});

describe("createContainerAuthor: every way a run ends badly is one closed code", () => {
  const timeout = { kind: "timeout", stdout: "", stderr: "" } as const;
  const cases: Array<[string, AuthorScript, string]> = [
    ["codex times out", { codexResult: timeout }, "timeout"],
    ["codex cannot be spawned", { codexResult: { kind: "error", code: null, message: "x" } }, "spawn_failed"],
    ["codex prints too much", { codexResult: { ...timeout, kind: "output_limit" } }, "output_limit"],
    ["codex exits non-zero", { codexStatus: 3 }, "nonzero_exit"],
    ["codex wrote no answer file", { answer: null }, "no_output"],
    ["the answer is not the envelope", { answer: '{"scenarios_yaml":"x","note":"y"}' }, "no_output"],
    ["the answer holds the key", { answer: `{"scenarios_yaml":"token ${AUTHOR_KEY}"}` }, "credential_in_output"],
  ];

  it.each(cases)("%s", async (_label, script, code) => {
    const double = authorDouble(script);
    const session = createContainerAuthor(authorDeps(double));
    expect(await session.run(authorRequest())).toMatchObject({ ok: false, code });
    expect(Object.keys(double.fake.state.containers)).toEqual([]);
    const facts = session.takeFacts();
    expect(facts?.outcome).toBe(code);
    if (code === "credential_in_output") {
      expect(facts).toMatchObject({ answer_sha256: null, answer_bytes: 0 });
      expect(facts?.credential_hits).toBeGreaterThan(0);
    }
  });

  it("finds a key that holds a quote in the JSON-escaped spelling the answer file uses", async () => {
    const key = `${AUTHOR_KEY}"q`;
    const double = authorDouble({ answer: `${JSON.stringify({ scenarios_yaml: `token ${key}` })}\n` });
    const session = createContainerAuthor(authorDeps(double, { credential: authorCredential(key) }));
    expect(await session.run(authorRequest())).toMatchObject({ ok: false, code: "credential_in_output" });
  });

  it.each([
    ["no inputs", { inputs: undefined }],
    ["a prompt that is not the one built from the inputs", { prompt: "tampered" }],
    ["a zero timeout", { timeoutMs: 0 }],
  ])("refuses %s before any container exists", async (_label, change) => {
    const double = authorDouble();
    const session = createContainerAuthor(authorDeps(double));
    const outcome = await session.run({ ...authorRequest(), ...change } as unknown as ReturnType<typeof authorRequest>);
    expect(outcome).toMatchObject({ ok: false, code: "misconfigured" });
    expect(double.fake.calls("create")).toHaveLength(0);
    expect(session.takeFacts()).toBeNull();
  });

  it("refuses a config without an author image and a credential that is not the Codex one", async () => {
    const double = authorDouble();
    const config = authorConfig();
    const noImage = { ...config, author: { ...config.author, image: null } };
    const bare = createContainerAuthor(authorDeps(double, { config: noImage }));
    expect(await bare.run(authorRequest())).toMatchObject({ ok: false, code: "misconfigured" });
    const other = readCredential("claude", { OMF_IMPLEMENTER_API_KEY: "implementer-key-0123456789" });
    if (other === null) throw new Error("the implementer key was rejected");
    const wrong = createContainerAuthor(authorDeps(double, { credential: other }));
    expect(await wrong.run(authorRequest())).toMatchObject({ ok: false, code: "misconfigured" });
    expect(double.fake.calls("create")).toHaveLength(0);
  });
});

describe("createContainerAuthor inside runSealStage", () => {
  it("stamps the seal as a container author, hashes the prompt without the suffix, and holds the measurement at the hook", async () => {
    const s = sealFixture();
    const answer = JSON.stringify({
      scenarios_yaml: `${authoredDoc({ split: "train" })}\n---\n${authoredDoc({ split: "test" })}\n`,
    });
    const double = authorDouble({ answer });
    const session = createContainerAuthor(authorDeps(double, { location: s.f.fx.location, workId: s.f.workId }));
    const atHook: Array<{ sealed: SealedPass; measurement: StageMeasurement | null }> = [];

    const result = stored(
      await runSealStage(
        depsFor(s, session, {
          afterSealCompleted: (sealed) => void atHook.push({ sealed, measurement: session.takeMeasurement() }),
        }),
      ),
    );

    expect(result.author).toMatchObject({ vendor: "codex", model: "gpt-5-codex", isolation: "container" });
    expect(atHook).toHaveLength(1);
    expect(atHook[0]?.sealed.seal_id).toBe(result.seal_id);
    expect(atHook[0]?.measurement).toMatchObject({ stage: "author", level: "L2" });
    const stdin = stdinOf(double.execs.find((call) => call.argv[0] === "codex"));
    expect(stdin.endsWith(OUTPUT_SUFFIX)).toBe(true);
    const prompt = stdin.slice(0, stdin.length - OUTPUT_SUFFIX.length);
    const requested = s.f.fx.ledger.readVerified().find((event) => event.type === "seal.requested");
    expect(requested?.payload.input_sha256).toBe(sha256Hex(prompt));
    expect(session.takeFacts()?.input_sha256).toBe(sha256Hex(stdin));
  });
});

describe("createContainerAuthor: an unexpected throw still counts as a call", () => {
  it("records the facts when the Codex exec throws a plain Error, then rethrows", async () => {
    const double = authorDouble();
    const runtime = new Proxy(double.runtime, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== "exec" || typeof value !== "function") return value;
        return async (handle: unknown, spec: { argv: string[] }) => {
          if (spec.argv[0] === "codex") throw new Error("adapter bug");
          return (value as (...a: unknown[]) => unknown).call(target, handle, spec);
        };
      },
    });
    const session = createContainerAuthor(authorDeps({ ...double, runtime }));
    await expect(session.run(authorRequest())).rejects.toThrow("adapter bug");
    expect(session.takeFacts()).toMatchObject({ outcome: "container_failed", vendor: "codex" });
    expect(Object.keys(double.fake.state.containers)).toEqual([]);
  });
});
