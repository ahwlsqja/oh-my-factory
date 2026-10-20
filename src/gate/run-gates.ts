import { GATE_NAMES, type GateName, type JudgeConfigDecl } from "../decision/types.js";
import {
  type GateLineValue,
  type GateLineValues,
  type GateLineVerdict,
  evaluateGateLine,
  formatGateLine,
  parseGateLine,
} from "./gate-line.js";
import type { CommandResult, CommandTarget, RunOptions } from "./ports.js";

/**
 * The error codes of a work copy that lost its container or could not run at all: the host's doing, never evidence about a gate.
 * `runtime_error` is what the work copy reports for a failure the candidate cannot cause: a docker client error or an exit with no
 * status, a recreate that failed in the client (during the build or extract exec), on create, measure or the daemon, an extract
 * timeout, or a disposed copy. It stops the line like a lost container. A recreate that failed on the candidate's own build or
 * extract (a non-zero exit, or a build timeout) is `workcopy_boot_failed`, which is not here: the gate fails. A non-zero exit counts
 * as `workcopy_boot_failed` only when stopCause says running or candidate; when it says host or unknown it is `runtime_error`.
 */
const LOST_CONTAINER_CODES: ReadonlySet<string> = new Set([
  "workcopy_container_gone",
  "workcopy_exit_unknown",
  "runtime_error",
]);

/**
 * The error codes of a work copy that tell the candidate's own failure, without a status: a recreate whose candidate build or
 * extract failed (`workcopy_boot_failed`) and a command in a container that stopped early on its own (`workcopy_candidate_stopped`).
 * A gate that meets one is `fail`, never `skip`.
 */
const CANDIDATE_FAILURE_CODES: ReadonlySet<string> = new Set(["workcopy_boot_failed", "workcopy_candidate_stopped"]);

/**
 * A declared gate (required or not) ran in a container that was lost, or the work copy could not run it for a reason of the host. That is an infrastructure error that blocks the line: it
 * must not become `skip`, which a gate that is not required would turn into GREEN. The message is the code only.
 */
export class GateInfrastructureError extends Error {
  constructor(
    readonly gate: GateName,
    readonly code: string,
  ) {
    super(code);
    this.name = "GateInfrastructureError";
  }
}

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
  const last = stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .at(-1);
  const match = last === undefined ? null : GATE_RULES_MARKER.exec(last);
  if (match === null) return null;
  const count = Number(match[1]);
  return Number.isSafeInteger(count) ? count : null;
}

/**
 * exit 0 is `pass` (`empty` when the marker says 0 rules); a non-zero exit, a signal, a timeout or the output limit is `fail`, and so are the error results
 * `workcopy_boot_failed` and `workcopy_candidate_stopped`;
 * a runner error is `skip` (the gate never ran: environment), except a lost container, which `runGates` stops on. Only the exit status and the marker integer are read;
 * stdout and stderr are hostile and nothing else is kept.
 */
export function gateValueOf(result: CommandResult): { value: GateLineValue; rules: number | null } {
  if (result.kind === "error")
    return { value: result.code !== null && CANDIDATE_FAILURE_CODES.has(result.code) ? "fail" : "skip", rules: null };
  if (result.kind !== "exited") return { value: "fail", rules: null };
  const rules = rulesOf(result.stdout);
  if (result.status !== 0) return { value: "fail", rules };
  return { value: rules === 0 ? "empty" : "pass", rules };
}

/** The default timeout of one gate, milliseconds; `WORKCOPY_GATE_EXEC_S` in the container layer is pinned to it. */
export const GATE_DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_OPTIONS: RunOptions = { timeoutMs: GATE_DEFAULT_TIMEOUT_MS, maxOutputBytes: 1024 * 1024 };

/**
 * Runs the declared gates fast, full, deep with no short-circuit (the line is complete evidence). The line is built
 * here with `formatGateLine`, never read from a gate's output; the verdict is `evaluateGateLine` over that line.
 */
export async function runGates(
  gates: JudgeConfigDecl["gates"],
  target: CommandTarget,
  options: Partial<RunOptions> = {},
): Promise<GateRunResult> {
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
    if (result.kind === "error" && result.code !== null && LOST_CONTAINER_CODES.has(result.code)) {
      throw new GateInfrastructureError(gate, result.code);
    }
    const { value, rules } = gateValueOf(result);
    values[gate] = value;
    details.push({ gate, value, exit: result.kind === "exited" ? result.status : null, outcome: result.kind, rules });
  }
  const line = formatGateLine(values);
  return { line, values, verdict: evaluateGateLine(parseGateLine(line), gates.required), details };
}
