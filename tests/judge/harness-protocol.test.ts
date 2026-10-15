import { describe, expect, it } from "vitest";
import type { ProcessResult } from "../../src/adapters/process-group.js";
import type { ContainerHandle, ContainerRuntime, ExecSpec } from "../../src/container/runtime.js";
import { validateDef } from "../../src/core/schema.js";
import {
  HARNESS_EXEC_ARGV,
  HARNESS_SCHEMA,
  HarnessError,
  type HarnessSet,
  createHarnessClient,
  harnessScenarioOf,
} from "../../src/judge/harness-protocol.js";
import { DEFAULT_STEP_LIMITS } from "../../src/scenario/runner.js";
import { type StoredScenario, scenarioRef } from "../../src/scenario/types.js";

const NONCE = "0123456789abcdef";
const REF = "aaaaaaaaaaaaaaaa";
const HANDLE: ContainerHandle = { name: "omf-harness-r-20261015T010203Z-ab12-1-1", id: "c0ffee", role: "harness" };
const SET: HarnessSet = {
  schema_version: 1,
  scenarios: [
    {
      scenario_ref: REF,
      steps: [
        {
          invoke: { argv: ["add", "zz-distinct-key"], stdin: "" },
          expect: { exit_code: 0, stdout_matches: { kind: "exact", text: "ok\n" }, json_path: null },
        },
      ],
    },
  ],
};

const exited = (stdout: string, status = 0): ProcessResult => ({
  kind: "exited",
  status,
  signal: null,
  stdout,
  stderr: "",
});

/** A runtime whose `exec` returns the scripted results in order and records every call. */
function stub(results: ProcessResult[]) {
  const calls: ExecSpec[] = [];
  const runtime: Pick<ContainerRuntime, "exec"> = {
    exec: async (_handle, spec) => {
      calls.push(spec);
      const next = results.shift();
      if (next === undefined) throw new Error("no scripted result left");
      return next;
    },
  };
  return { runtime, calls };
}

const reply = (value: unknown): ProcessResult => exited(JSON.stringify(value));
const verdictOf = (nonce: string) => ({
  schema_version: 1,
  nonce,
  runs: [{ scenario_ref: REF, rep: 1, outcome: "pass", steps_passed: 1, steps_total: 1 }],
});

describe("the harness set is a projection", () => {
  const CANARY = "omf-canary-0123456789abcdef0123456789abcdef";
  const stored: StoredScenario = {
    schema_version: 1,
    scenario_id: `s-${"a1".repeat(16)}`,
    work_id: "w-0123456789ab",
    author: { vendor: "acme-author", model: "model-x-9", at: "2026-10-15T00:00:00Z", isolation: "host_command" },
    decision_refs: ["d-planted-ref"],
    kind: "behavior",
    split: "train",
    interface: "cli",
    canary: CANARY,
    steps: [
      {
        invoke: { argv: ["add", "x"], stdin: "in" },
        expect: {
          exit_code: 0,
          stdout_matches: { kind: "exact", text: "ok\n" },
          json_path: null,
          note: `${CANARY} planted assertion note`,
        },
      },
    ],
  };

  it("holds the scenario ref and the steps, and no id, canary, author, decision ref or note", () => {
    const projected = harnessScenarioOf(stored);
    expect(projected.scenario_ref).toBe(scenarioRef(stored.scenario_id));
    expect(Object.keys(projected).sort()).toEqual(["scenario_ref", "steps"]);
    const text = JSON.stringify({ schema_version: 1, scenarios: [projected] });
    for (const planted of [
      CANARY,
      stored.scenario_id,
      stored.work_id,
      "acme-author",
      "model-x-9",
      "d-planted-ref",
      "planted assertion note",
    ]) {
      expect(text).not.toContain(planted);
    }
    expect(text).toContain("ok\\n");
    expect(validateDef(HARNESS_SCHEMA, "harness_set", { schema_version: 1, scenarios: [projected] }).ok).toBe(true);
  });
});

describe("the protocol schema", () => {
  const observation = { outcome: "exited", exit_code: 0, stdout: "ok\n" };
  const VALID = [
    { op: "load", nonce: NONCE, set: SET },
    { op: "begin", nonce: NONCE, scenario_ref: REF, rep: 1 },
    { op: "observe", nonce: NONCE, scenario_ref: REF, rep: 1, step_index: 0, observation },
    { op: "verdict", nonce: NONCE },
  ];
  const INVALID = [
    { op: "begin", nonce: NONCE, scenario_ref: REF, rep: 0 },
    { op: "load", nonce: "XYZ", set: SET },
    { op: "verdict", nonce: NONCE, extra: true },
    { op: "observe", nonce: NONCE, scenario_ref: REF, rep: 1, step_index: 0, observation: { outcome: "exited" } },
    { op: "begin", nonce: NONCE, scenario_ref: "not-a-ref", rep: 1 },
  ];

  it("accepts each of the four requests and refuses a malformed or widened one", () => {
    for (const request of VALID) expect(validateDef(HARNESS_SCHEMA, "request", request).ok).toBe(true);
    for (const request of INVALID) expect(validateDef(HARNESS_SCHEMA, "request", request).ok).toBe(false);
  });

  it("accepts the four replies and refuses an extra field", () => {
    const invoke = { argv: ["a"], stdin: "" };
    const replies = [
      { op: "load", nonce: NONCE, scenarios_total: 1 },
      { op: "begin", nonce: NONCE, steps_total: 1, invoke },
      { op: "observe", nonce: NONCE, step_pass: true, next: null },
      { op: "verdict", nonce: NONCE, verdict: verdictOf(NONCE) },
    ];
    for (const value of replies) {
      expect(validateDef(HARNESS_SCHEMA, "reply", value).ok).toBe(true);
      expect(validateDef(HARNESS_SCHEMA, "reply", { ...value, extra: 1 }).ok).toBe(false);
    }
  });
});

describe("the host client", () => {
  it("sends the set only in load, over stdin, with a constant argv and the round nonce on every request", async () => {
    const invoke = { argv: ["add", "zz-distinct-key"], stdin: "" };
    const { runtime, calls } = stub([
      reply({ op: "load", nonce: NONCE, scenarios_total: 1 }),
      reply({ op: "begin", nonce: NONCE, steps_total: 1, invoke }),
      reply({ op: "observe", nonce: NONCE, step_pass: true, next: null }),
      reply({ op: "verdict", nonce: NONCE, verdict: verdictOf(NONCE) }),
    ]);
    const client = createHarnessClient(runtime, HANDLE, DEFAULT_STEP_LIMITS, { nonce: NONCE });
    await client.load(SET);
    expect(await client.begin(REF, 1)).toEqual({ steps_total: 1, invoke });
    expect(await client.observe(REF, 1, 0, { outcome: "exited", exit_code: 0, stdout: "ok\n" })).toEqual({
      step_pass: true,
      next: null,
    });
    expect((await client.verdict()).runs).toHaveLength(1);

    for (const call of calls) expect(call.argv).toEqual([...HARNESS_EXEC_ARGV]);
    const requests = calls.map((call) => JSON.parse(String(call.stdin)) as Record<string, unknown>);
    expect(requests.map((request) => request.op)).toEqual(["load", "begin", "observe", "verdict"]);
    expect(requests.map((request) => "set" in request)).toEqual([true, false, false, false]);
    expect(requests.every((request) => request.nonce === NONCE)).toBe(true);
    for (const request of requests) expect(validateDef(HARNESS_SCHEMA, "request", request).ok).toBe(true);
    expect(
      calls
        .slice(1)
        .map((call) => String(call.stdin))
        .join(""),
    ).not.toContain("zz-distinct-key");
  });

  it("draws a fresh 16-hex nonce per client when none is given", () => {
    const a = createHarnessClient(stub([]).runtime, HANDLE, DEFAULT_STEP_LIMITS).nonce;
    const b = createHarnessClient(stub([]).runtime, HANDLE, DEFAULT_STEP_LIMITS).nonce;
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });

  const FAILURES: ReadonlyArray<[string, ProcessResult, string]> = [
    ["empty stdout", exited(""), "reply_missing"],
    ["not JSON", exited("{nope"), "reply_malformed"],
    ["an extra field", reply({ op: "load", nonce: NONCE, scenarios_total: 1, extra: 1 }), "reply_malformed"],
    ["a foreign nonce", reply({ op: "load", nonce: "ffffffffffffffff", scenarios_total: 1 }), "reply_malformed"],
    ["another op", reply({ op: "verdict", nonce: NONCE, verdict: verdictOf(NONCE) }), "reply_malformed"],
    ["a wrong scenario count", reply({ op: "load", nonce: NONCE, scenarios_total: 2 }), "reply_malformed"],
    ["the output limit", { kind: "output_limit", stdout: "", stderr: "" }, "reply_too_large"],
    ["a non-zero exit", exited("", 2), "exec_failed"],
    ["a timeout", { kind: "timeout", stdout: "", stderr: "" }, "exec_failed"],
    ["a spawn error", { kind: "error", code: null, message: "x" }, "exec_failed"],
  ];

  it.each(FAILURES)("a load answered with %s throws %s... never a pass", async (_name, result, code) => {
    const client = createHarnessClient(stub([result]).runtime, HANDLE, DEFAULT_STEP_LIMITS, { nonce: NONCE });
    await expect(client.load(SET)).rejects.toMatchObject({ name: "HarnessError", code });
  });

  it("refuses a verdict whose inner nonce is foreign, even when the outer one matches", async () => {
    const forged = reply({ op: "verdict", nonce: NONCE, verdict: verdictOf("ffffffffffffffff") });
    const client = createHarnessClient(stub([forged]).runtime, HANDLE, DEFAULT_STEP_LIMITS, { nonce: NONCE });
    await expect(client.verdict()).rejects.toBeInstanceOf(HarnessError);
  });
});
