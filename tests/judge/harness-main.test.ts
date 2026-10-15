import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProcessResult } from "../../src/adapters/process-group.js";
import { pinnedImage } from "../../src/container/image-ref.js";
import type { ContainerHandle, ContainerRuntime } from "../../src/container/runtime.js";
import { harnessContextSha256, harnessSources, writeHarnessContext } from "../../src/judge/harness-context.js";
import { type HarnessSet, createHarnessClient } from "../../src/judge/harness-protocol.js";
import { DEFAULT_STEP_LIMITS } from "../../src/scenario/runner.js";
import { makeTempDir } from "../helpers/tmp.js";

const BASE = pinnedImage(`registry.example/node@sha256:${"c".repeat(64)}`);
const NONCE = "0123456789abcdef";
const A = "aaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbb";
const C = "cccccccccccccccc";

const SET: HarnessSet = {
  schema_version: 1,
  scenarios: [
    {
      scenario_ref: A,
      steps: [
        {
          invoke: { argv: ["add", "x"], stdin: "" },
          expect: { exit_code: 0, stdout_matches: { kind: "exact", text: "ok\n" }, json_path: null },
        },
      ],
    },
    {
      scenario_ref: B,
      steps: [
        {
          invoke: { argv: ["get"], stdin: "" },
          expect: { exit_code: null, stdout_matches: null, json_path: { "$.n": 2 } },
        },
        {
          invoke: { argv: ["ver"], stdin: "" },
          expect: { exit_code: 0, stdout_matches: { kind: "anchored", pattern: "^v\\d+\n$" }, json_path: null },
        },
      ],
    },
    {
      scenario_ref: C,
      steps: [
        {
          invoke: { argv: ["dump"], stdin: "" },
          expect: { exit_code: 0, stdout_matches: { kind: "anchored", pattern: "^a*$" }, json_path: null },
        },
      ],
    },
  ],
};

const exited = (stdout: string, exit_code = 0) => ({ outcome: "exited" as const, exit_code, stdout });
const load = { op: "load", nonce: NONCE, set: SET };
const begin = (ref: string, rep: number) => ({ op: "begin", nonce: NONCE, scenario_ref: ref, rep });
const observe = (ref: string, rep: number, step_index: number, observation: unknown) => ({
  op: "observe",
  nonce: NONCE,
  scenario_ref: ref,
  rep,
  step_index,
  observation,
});
const verdict = { op: "verdict", nonce: NONCE };

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** A staged copy of the shipped program with its own state directory: OMF code run on the host, never candidate code. */
function stage(): { run: (request: unknown) => Run; json: (request: unknown) => Record<string, unknown> } {
  const dir = makeTempDir("omf-harness-ctx-");
  const sources = harnessSources();
  writeHarnessContext(dir, sources, BASE, harnessContextSha256(sources, BASE));
  const state = join(makeTempDir("omf-harness-state-"), "s");
  const run = (request: unknown): Run => {
    const result = spawnSync(process.execPath, [join(dir, "main.mjs"), state], {
      input: typeof request === "string" ? request : JSON.stringify(request),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const json = (request: unknown): Record<string, unknown> => {
    const result = run(request);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  };
  return { run, json };
}

describe("harness/main.mjs", () => {
  it("judges scenarios step by step and reports a sorted verdict that echoes the nonce", () => {
    const h = stage();
    expect(h.json(load)).toEqual({ op: "load", nonce: NONCE, scenarios_total: 3 });
    expect(h.json(begin(A, 1))).toEqual({
      op: "begin",
      nonce: NONCE,
      steps_total: 1,
      invoke: { argv: ["add", "x"], stdin: "" },
    });
    expect(h.json(observe(A, 1, 0, exited("ok\n")))).toEqual({
      op: "observe",
      nonce: NONCE,
      step_pass: true,
      next: null,
    });
    h.json(begin(B, 1));
    expect(h.json(observe(B, 1, 0, exited('{"n":2}')))).toEqual({
      op: "observe",
      nonce: NONCE,
      step_pass: true,
      next: { argv: ["ver"], stdin: "" },
    });
    expect(h.json(observe(B, 1, 1, exited("v12\n"))).next).toBeNull();
    h.json(begin(A, 2));
    expect(h.json(observe(A, 2, 0, exited("ok\n", 1)))).toMatchObject({ step_pass: false, next: null });

    expect(h.json(verdict)).toEqual({
      op: "verdict",
      nonce: NONCE,
      verdict: {
        schema_version: 1,
        nonce: NONCE,
        runs: [
          { scenario_ref: A, rep: 1, outcome: "pass", steps_passed: 1, steps_total: 1 },
          { scenario_ref: A, rep: 2, outcome: "fail", steps_passed: 0, steps_total: 1 },
          { scenario_ref: B, rep: 1, outcome: "pass", steps_passed: 2, steps_total: 2 },
        ],
      },
    });
  });

  const OUTCOMES: ReadonlyArray<[string, unknown, boolean, string]> = [
    ["a signal", { outcome: "signaled", signal: "SIGKILL" }, false, "fail"],
    ["a timeout", { outcome: "timeout" }, false, "fail"],
    ["the output limit", { outcome: "output_limit" }, false, "fail"],
    ["a runtime error", { outcome: "error" }, false, "error"],
    ["a refused step", { outcome: "refused", code: "candidate_needs_container" }, false, "error"],
  ];

  it.each(OUTCOMES)("scores %s as a failing step and the run as %s", (_name, observation, stepPass, outcome) => {
    const h = stage();
    h.json(load);
    h.json(begin(A, 1));
    expect(h.json(observe(A, 1, 0, observation))).toMatchObject({ step_pass: stepPass, next: null });
    const runs = (h.json(verdict).verdict as { runs: { outcome: string }[] }).runs;
    expect(runs.map((run) => run.outcome)).toEqual([outcome]);
  });

  it("reports a run that was begun and never finished as an error", () => {
    const h = stage();
    h.json(load);
    h.json(begin(B, 1));
    const runs = (h.json(verdict).verdict as { runs: unknown[] }).runs;
    expect(runs).toEqual([{ scenario_ref: B, rep: 1, outcome: "error", steps_passed: 0, steps_total: 2 }]);
  });

  it("matches a 1 MiB stdout, and fails one byte more", () => {
    const h = stage();
    h.json(load);
    h.json(begin(C, 1));
    expect(h.json(observe(C, 1, 0, exited("a".repeat(1024 * 1024)))).step_pass).toBe(true);
    h.json(begin(C, 2));
    expect(h.json(observe(C, 2, 0, exited("a".repeat(1024 * 1024 + 1)))).step_pass).toBe(false);
  });

  const REFUSALS: ReadonlyArray<[string, unknown[], unknown, string]> = [
    ["an unknown op", [load], { op: "drop", nonce: NONCE }, "unknown_op"],
    ["a wrong nonce", [load], { op: "verdict", nonce: "ffffffffffffffff" }, "nonce_mismatch"],
    ["a request that is not JSON", [], "{oops", "request_malformed"],
    ["an op before load", [], verdict, "not_loaded"],
    ["a second load", [load], load, "already_loaded"],
    ["an empty set", [], { op: "load", nonce: NONCE, set: { schema_version: 1, scenarios: [] } }, "set_invalid"],
    [
      "an expectation with nothing to check",
      [],
      {
        op: "load",
        nonce: NONCE,
        set: {
          schema_version: 1,
          scenarios: [
            {
              scenario_ref: A,
              steps: [
                {
                  invoke: { argv: [], stdin: "" },
                  expect: { exit_code: null, stdout_matches: null, json_path: null },
                },
              ],
            },
          ],
        },
      },
      "set_invalid",
    ],
    ["an unknown scenario", [load], begin("dddddddddddddddd", 1), "unknown_scenario"],
    ["a run begun twice", [load, begin(A, 1)], begin(A, 1), "duplicate_run"],
    ["an observation before begin", [load], observe(A, 1, 0, exited("ok\n")), "run_not_begun"],
    ["a step out of order", [load, begin(B, 1)], observe(B, 1, 1, exited("v1\n")), "step_out_of_order"],
    ["a malformed observation", [load, begin(A, 1)], observe(A, 1, 0, { outcome: "exited" }), "request_malformed"],
    ["an oversize request", [], "x".repeat(8 * 1024 * 1024 + 1), "request_too_large"],
  ];

  it.each(REFUSALS)("refuses %s with status 2, an empty stdout and the code", (_name, before, request, code) => {
    const h = stage();
    for (const earlier of before) h.json(earlier);
    const result = h.run(request);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`refused: ${code}\n`);
  });
});

describe("the host client against the real program", () => {
  it("passes the whole protocol, every reply schema-checked", async () => {
    const h = stage();
    const handle: ContainerHandle = { name: "omf-harness-r-20261015T010203Z-ab12-1-1", id: "c0ffee", role: "harness" };
    const runtime: Pick<ContainerRuntime, "exec"> = {
      exec: async (_handle, spec): Promise<ProcessResult> => {
        const result = h.run(String(spec.stdin));
        return { kind: "exited", status: result.status, signal: null, stdout: result.stdout, stderr: result.stderr };
      },
    };
    const client = createHarnessClient(runtime, handle, DEFAULT_STEP_LIMITS, { nonce: NONCE });
    await client.load(SET);
    expect((await client.begin(B, 1)).steps_total).toBe(2);
    expect((await client.observe(B, 1, 0, exited('{"n":2}'))).next).toEqual({ argv: ["ver"], stdin: "" });
    expect(await client.observe(B, 1, 1, exited("v9\n"))).toEqual({ step_pass: true, next: null });
    expect((await client.verdict()).runs).toEqual([
      { scenario_ref: B, rep: 1, outcome: "pass", steps_passed: 2, steps_total: 2 },
    ]);
    await expect(client.begin(B, 1)).rejects.toMatchObject({ code: "exec_failed" });
  });
});
