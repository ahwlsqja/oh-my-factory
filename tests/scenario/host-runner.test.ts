import { describe, expect, it } from "vitest";
import type { ProcessOptions, ProcessResult, runProcessGroup } from "../../src/adapters/process-group.js";
import { createHostFixtureRunner } from "../../src/scenario/fixtures.js";
import { DEFAULT_STEP_LIMITS, runScenario } from "../../src/scenario/runner.js";
import type { FixtureId, StepInput, StepLimits } from "../../src/scenario/runner.js";
import { stepOf, runnerScenario } from "../helpers/runner-scenario.js";
import { makeTempDir } from "../helpers/tmp.js";

const OK: ProcessResult = { kind: "exited", status: 0, signal: null, stdout: "", stderr: "" };
const STEP: StepInput = { argv: ["x"], stdin: "" };

/** An exec double that returns `result` and records every spawn. */
function recordingExec(result: ProcessResult = OK) {
  const calls: { argv: string[]; options: ProcessOptions }[] = [];
  const exec: typeof runProcessGroup = async (argv, options) => {
    calls.push({ argv: [...argv], options });
    return result;
  };
  return { exec, calls };
}

async function once(id: FixtureId, step: StepInput, limits: StepLimits = DEFAULT_STEP_LIMITS) {
  const runner = createHostFixtureRunner({ scratchRoot: makeTempDir("omf-scratch-") });
  const session = await runner.openScenario({ kind: "fixture", id });
  try {
    return await session.runStep(step, limits);
  } finally {
    await session.close();
  }
}

describe("host fixture runner: the three fixtures run for real", () => {
  it("null-error exits 1 with no output", async () => {
    expect(await once("null-error", { argv: ["add", "x"], stdin: "in" })).toEqual({
      outcome: "exited",
      exit_code: 1,
      stdout: "",
    });
  });

  it("null-empty exits 0 with empty stdout", async () => {
    expect(await once("null-empty", { argv: ["add", "x"], stdin: "in" })).toEqual({
      outcome: "exited",
      exit_code: 0,
      stdout: "",
    });
  });

  it("echo-everything prints its arguments, a newline and stdin", async () => {
    expect(await once("echo-everything", { argv: ["a", "b c"], stdin: "in" })).toEqual({
      outcome: "exited",
      exit_code: 0,
      stdout: "a b c\nin",
    });
  });

  it("maps an output that exceeds the limit to output_limit", async () => {
    const step = { argv: [], stdin: "x".repeat(5000) };
    expect(await once("echo-everything", step, { timeoutMs: 5000, maxOutputBytes: 100 })).toEqual({
      outcome: "output_limit",
    });
  });
});

describe("host fixture runner: process results become observations", () => {
  it.each<[string, ProcessResult, unknown]>([
    [
      "a normal exit",
      { kind: "exited", status: 3, signal: null, stdout: "hi\n", stderr: "" },
      { outcome: "exited", exit_code: 3, stdout: "hi\n" },
    ],
    [
      "a signal",
      { kind: "exited", status: null, signal: "SIGKILL", stdout: "", stderr: "" },
      { outcome: "signaled", signal: "SIGKILL" },
    ],
    [
      "invalid UTF-8 (U+FFFD)",
      { kind: "exited", status: 0, signal: null, stdout: "a�b", stderr: "" },
      { outcome: "error" },
    ],
    ["a timeout", { kind: "timeout", stdout: "", stderr: "" }, { outcome: "timeout" }],
    ["the output limit", { kind: "output_limit", stdout: "", stderr: "" }, { outcome: "output_limit" }],
    ["a spawn error", { kind: "error", code: "ENOENT", message: "gone" }, { outcome: "error" }],
  ])("%s", async (_name, result, expected) => {
    const { exec } = recordingExec(result);
    const runner = createHostFixtureRunner({ exec, scratchRoot: makeTempDir("omf-scratch-") });
    const session = await runner.openScenario({ kind: "fixture", id: "null-empty" });
    expect(await session.runStep(STEP, DEFAULT_STEP_LIMITS)).toEqual(expected);
    await session.close();
  });

  it("passes the step limits to the spawn and reports an error after close()", async () => {
    const { exec, calls } = recordingExec();
    const runner = createHostFixtureRunner({ exec, scratchRoot: makeTempDir("omf-scratch-") });
    const session = await runner.openScenario({ kind: "fixture", id: "null-empty" });
    await session.runStep({ argv: [], stdin: "s" }, { timeoutMs: 123, maxOutputBytes: 456 });
    expect(calls[0]?.options).toMatchObject({ timeoutMs: 123, maxOutputBytes: 456, stdin: "s" });
    await session.close();
    expect(await session.runStep(STEP, DEFAULT_STEP_LIMITS)).toEqual({ outcome: "error" });
    expect(calls).toHaveLength(1);
  });
});

describe("runScenario through the host adapter", () => {
  const weak = runnerScenario({
    steps: [stepOf(["x"], { exit_code: 1, stdout_matches: { kind: "exact", text: "" } })],
  });

  it("a scenario that expects exit 1 and empty stdout passes null-error and fails null-empty", async () => {
    const runner = createHostFixtureRunner({ scratchRoot: makeTempDir("omf-scratch-") });
    expect((await runScenario(runner, { kind: "fixture", id: "null-error" }, weak)).outcome).toBe("pass");
    expect((await runScenario(runner, { kind: "fixture", id: "null-empty" }, weak)).outcome).toBe("fail");
  });

  it("a refused target is an error, never a pass", async () => {
    const runner = createHostFixtureRunner({ scratchRoot: makeTempDir("omf-scratch-") });
    expect(await runScenario(runner, { kind: "candidate", handle: "image:abc" }, weak)).toMatchObject({
      outcome: "error",
      steps_passed: 0,
    });
  });
});
