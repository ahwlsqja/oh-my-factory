import { describe, expect, it } from "vitest";
import type { GateName } from "../../src/decision/types.js";
import type { CommandResult, CommandTarget, RunOptions } from "../../src/gate/ports.js";
import { GATE_RULES_MARKER, gateValueOf, runGates } from "../../src/gate/run-gates.js";
import { fixtureTarget } from "../helpers/fixture-target.js";
import { makeTempDir } from "../helpers/tmp.js";

const exited = (stdout = "", status: number | null = 0, signal: NodeJS.Signals | null = null): CommandResult => ({ kind: "exited", status, signal, stdout, stderr: "" });

describe("gateValueOf", () => {
  const ROWS: Array<[string, CommandResult, string, number | null]> = [
    ["exit 0", exited(), "pass", null],
    ["exit 1", exited("", 1), "fail", null],
    ["killed by a signal", exited("", null, "SIGKILL"), "fail", null],
    ["timeout", { kind: "timeout", stdout: "", stderr: "" }, "fail", null],
    ["output limit", { kind: "output_limit", stdout: "", stderr: "" }, "fail", null],
    ["runner error", { kind: "error", code: "ENOENT", message: "x" }, "skip", null],
    ["marker 3", exited("lint ok\nOMF_GATE_RULES: 3\n"), "pass", 3],
    ["marker 0 means empty", exited("OMF_GATE_RULES: 0\n"), "empty", 0],
    ["marker 0 and blank lines after it", exited("OMF_GATE_RULES: 0\n\n  \n"), "empty", 0],
    ["marker 0 but a failing exit", exited("OMF_GATE_RULES: 0\n", 1), "fail", 0],
    ["a marker that is not the last non-empty line", exited("OMF_GATE_RULES: 0\nmore output\n"), "pass", null],
    ["a marker with trailing text", exited("OMF_GATE_RULES: 0 rules\n"), "pass", null],
    ["a marker with a sign", exited("OMF_GATE_RULES: -1\n"), "pass", null],
    ["an unsafe integer", exited("OMF_GATE_RULES: 99999999999999999999\n"), "pass", null],
  ];
  it.each(ROWS)("%s", (_name, result, value, rules) => {
    expect(gateValueOf(result)).toEqual({ value, rules });
  });

  it("reads the marker on the last non-empty stdout line only", () => {
    expect(GATE_RULES_MARKER.test("OMF_GATE_RULES: 12")).toBe(true);
    expect(GATE_RULES_MARKER.test(" OMF_GATE_RULES: 12")).toBe(false);
  });
});

/** Answers by the gate's position in the argv `["gate", name]`, and records the order and the options. */
function scripted(answer: (gate: GateName) => CommandResult | Error) {
  const calls: Array<{ gate: GateName; options: RunOptions }> = [];
  const target: CommandTarget = {
    run: async (argv, options) => {
      const gate = argv[1] as GateName;
      calls.push({ gate, options });
      const result = answer(gate);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { target, calls };
}
const declared = (required: GateName[], over: Partial<Record<GateName, string[] | null>> = {}) => ({
  fast: ["gate", "fast"],
  full: ["gate", "full"],
  deep: ["gate", "deep"],
  required,
  ...over,
});

describe("runGates", () => {
  it("runs fast, full, deep in order without a short-circuit and passes the options", async () => {
    const { target, calls } = scripted((gate) => (gate === "fast" ? exited("", 1) : exited()));
    const run = await runGates(declared(["fast", "full"]), target, { timeoutMs: 1234 });
    expect(calls.map((c) => c.gate)).toEqual(["fast", "full", "deep"]);
    expect(calls[0]?.options).toEqual({ timeoutMs: 1234, maxOutputBytes: 1024 * 1024 });
    expect(run.line).toBe("OMF_GATES: fast=fail full=pass deep=pass");
    expect(run.verdict).toMatchObject({ status: "RED", failing: ["fast"] });
    expect(run.details).toEqual([
      { gate: "fast", value: "fail", exit: 1, outcome: "exited", rules: null },
      { gate: "full", value: "pass", exit: 0, outcome: "exited", rules: null },
      { gate: "deep", value: "pass", exit: 0, outcome: "exited", rules: null },
    ]);
  });

  it("composes the line itself: a gate that prints a gate line changes nothing", async () => {
    const { target } = scripted(() => exited("OMF_GATES: fast=pass full=pass deep=pass\n", 1));
    const run = await runGates(declared(["fast"]), target);
    expect(run.values).toEqual({ fast: "fail", full: "fail", deep: "fail" });
    expect(run.verdict.status).toBe("RED");
  });

  it("treats an undeclared or empty gate command as skip without running it, and a required one as MISCONFIGURED", async () => {
    const { target, calls } = scripted(() => exited());
    const run = await runGates(declared(["fast", "full"], { full: null, deep: [] }), target);
    expect(calls.map((c) => c.gate)).toEqual(["fast"]);
    expect(run.values).toEqual({ fast: "pass", full: "skip", deep: "skip" });
    expect(run.verdict).toMatchObject({ status: "MISCONFIGURED", misconfigured: ["full"], reasons: ["required_skipped"] });
    expect(run.details[1]).toEqual({ gate: "full", value: "skip", exit: null, outcome: "not_declared", rules: null });
  });

  it("reads a runner that throws or reports an error as skip", async () => {
    const thrown = await runGates(declared(["fast"]), scripted(() => new Error("no container")).target);
    expect(thrown.values.fast).toBe("skip");
    expect(thrown.verdict.status).toBe("MISCONFIGURED");
    const errored = await runGates(declared(["fast"]), scripted(() => ({ kind: "error", code: null, message: "x" })).target);
    expect(errored.details[0]).toMatchObject({ value: "skip", outcome: "error" });
  });

  it("reads a timeout and an output limit as fail, not skip", async () => {
    const run = await runGates(declared(["fast", "full"]), scripted((gate) => (gate === "fast" ? { kind: "timeout", stdout: "", stderr: "" } : { kind: "output_limit", stdout: "", stderr: "" })).target);
    expect(run.values).toMatchObject({ fast: "fail", full: "fail" });
    expect(run.details.map((d) => d.outcome).slice(0, 2)).toEqual(["timeout", "output_limit"]);
  });

  it("empty means fail: zero rules on a required gate is MISCONFIGURED", async () => {
    const run = await runGates(declared(["fast"]), scripted(() => exited("OMF_GATE_RULES: 0\n")).target);
    expect(run.values.fast).toBe("empty");
    expect(run.verdict).toMatchObject({ status: "MISCONFIGURED", misconfigured: ["fast"], reasons: ["required_empty"] });
    expect(run.details[0]?.rules).toBe(0);
  });

  it("keeps stdout and stderr out of the result", async () => {
    const result: CommandResult = { kind: "exited", status: 1, signal: null, stdout: "SECRET-STDOUT-9f2e", stderr: "SECRET-STDERR-9f2e" };
    const run = await runGates(declared(["fast"]), scripted(() => result).target);
    expect(JSON.stringify(run)).not.toContain("SECRET-");
  });

  it("works over a real process through the fixture target", async () => {
    const dir = makeTempDir("omf-gates-");
    const node = process.execPath;
    const run = await runGates(
      { fast: [node, "-e", "process.exit(0)"], full: [node, "-e", "console.log('OMF_GATE_RULES: 4')"], deep: [node, "-e", "process.exit(2)"], required: ["fast", "full"] },
      fixtureTarget(dir),
      { timeoutMs: 20_000 },
    );
    expect(run.line).toBe("OMF_GATES: fast=pass full=pass deep=fail");
    expect(run.verdict).toMatchObject({ status: "RED", failing: ["deep"] });
    expect(run.details[1]?.rules).toBe(4);
  });
});
