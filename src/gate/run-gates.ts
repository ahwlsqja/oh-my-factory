import { GATE_NAMES, type GateName, type JudgeConfigDecl } from "../decision/types.js";
import { type GateLineValue, type GateLineValues, type GateLineVerdict, evaluateGateLine, formatGateLine, parseGateLine } from "./gate-line.js";
import type { CommandResult, CommandTarget, RunOptions } from "./ports.js";

/** The last non-empty stdout line, when a gate wants to say how many rules it ran. */
export const GATE_RULES_MARKER = /^OMF_GATE_RULES: (\d+)$/;

export interface GateDetail {
  gate: GateName;
  value: GateLineValue;
  exit: number | null;
  outcome: "exited" | "timeout" | "output_limit" | "error" | "not_declared";
  rules: number | null;
}
export interface GateRunResult {
  line: string;
  values: GateLineValues;
  verdict: GateLineVerdict;
  details: GateDetail[];
}

function rulesOf(stdout: string): number | null {
  const last = stdout.split("\n").filter((line) => line.trim() !== "").at(-1);
  const match = last === undefined ? null : GATE_RULES_MARKER.exec(last);
  if (match === null) return null;
  const count = Number(match[1]);
  return Number.isSafeInteger(count) ? count : null;
}

/**
 * exit 0 is `pass` (`empty` when the marker says 0 rules); a non-zero exit, a signal, a timeout or the output limit is `fail`;
 * a runner error is `skip` (the gate never ran: environment). Only the exit status and the marker integer are read;
 * stdout and stderr are hostile and nothing else is kept.
 */
export function gateValueOf(result: CommandResult): { value: GateLineValue; rules: number | null } {
  if (result.kind === "error") return { value: "skip", rules: null };
  if (result.kind !== "exited") return { value: "fail", rules: null };
  const rules = rulesOf(result.stdout);
  if (result.status !== 0) return { value: "fail", rules };
  return { value: rules === 0 ? "empty" : "pass", rules };
}

const DEFAULT_OPTIONS: RunOptions = { timeoutMs: 600_000, maxOutputBytes: 1024 * 1024 };

/**
 * Runs the declared gates fast, full, deep with no short-circuit (the line is complete evidence). The line is built
 * here with `formatGateLine`, never read from a gate's output; the verdict is `evaluateGateLine` over that line.
 */
export async function runGates(gates: JudgeConfigDecl["gates"], target: CommandTarget, options: Partial<RunOptions> = {}): Promise<GateRunResult> {
  const runOptions: RunOptions = { ...DEFAULT_OPTIONS, ...options };
  const values = {} as GateLineValues;
  const details: GateDetail[] = [];
  for (const gate of GATE_NAMES) {
    const argv = gates[gate];
    if (argv === null || argv.length === 0) {
      values[gate] = "skip";
      details.push({ gate, value: "skip", exit: null, outcome: "not_declared", rules: null });
      continue;
    }
    let result: CommandResult;
    try {
      result = await target.run(argv, runOptions);
    } catch {
      result = { kind: "error", code: null, message: "runner threw" };
    }
    const { value, rules } = gateValueOf(result);
    values[gate] = value;
    details.push({ gate, value, exit: result.kind === "exited" ? result.status : null, outcome: result.kind, rules });
  }
  const line = formatGateLine(values);
  return { line, values, verdict: evaluateGateLine(parseGateLine(line), gates.required), details };
}
