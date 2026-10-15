import { randomBytes } from "node:crypto";
import type { ContainerHandle, ContainerRuntime } from "../container/runtime.js";
import { validateDef } from "../core/schema.js";
import type { StepLimits } from "../scenario/runner.js";
import { scenarioRef } from "../scenario/types.js";
import type { JsonScalar, StdoutMatch, StepObservation, StoredScenario } from "../scenario/types.js";

/** The schema file and the definitions the host checks every reply against. */
export const HARNESS_SCHEMA = "judge-harness.schema.json";
/** What `docker exec` runs in the harness container: constant, so no scenario data is ever part of an argv. */
export const HARNESS_EXEC_ARGV: readonly string[] = ["node", "/app/main.mjs"];
/** The program refuses a request above this many bytes (it drains stdin first, so the writer never sees EPIPE). */
export const MAX_HARNESS_REQUEST_BYTES = 8 * 1024 * 1024;

export interface HarnessInvoke {
  argv: string[];
  stdin: string;
}
export interface HarnessStep {
  invoke: HarnessInvoke;
  expect: {
    exit_code: number | null;
    stdout_matches: StdoutMatch | null;
    json_path: Record<string, JsonScalar> | null;
  };
}
export interface HarnessScenario {
  scenario_ref: string;
  steps: HarnessStep[];
}
/** No id, canary, author, decision refs or assertion note: the harness never sees what it does not need to judge. */
export interface HarnessSet {
  schema_version: 1;
  scenarios: HarnessScenario[];
}

/**
 * Copies, field by field, the part of a stored scenario the harness judges with. Nothing is spread from the stored
 * object, so a field added to `StoredScenario` later cannot reach the harness by accident.
 */
export function harnessScenarioOf(stored: StoredScenario): HarnessScenario {
  return {
    scenario_ref: scenarioRef(stored.scenario_id),
    steps: stored.steps.map((step) => ({
      invoke: { argv: [...step.invoke.argv], stdin: step.invoke.stdin },
      expect: {
        exit_code: step.expect.exit_code,
        stdout_matches: step.expect.stdout_matches === null ? null : { ...step.expect.stdout_matches },
        json_path: step.expect.json_path === null ? null : { ...step.expect.json_path },
      },
    })),
  };
}

/** `nonce` is 16 random hex chars chosen by the host per round: load stores it, every later request repeats it, every reply echoes it. */
export type HarnessRequest =
  | { op: "load"; nonce: string; set: HarnessSet }
  | { op: "begin"; nonce: string; scenario_ref: string; rep: number }
  | {
      op: "observe";
      nonce: string;
      scenario_ref: string;
      rep: number;
      step_index: number;
      observation: StepObservation;
    }
  | { op: "verdict"; nonce: string };

export interface HarnessVerdict {
  schema_version: 1;
  nonce: string;
  runs: {
    scenario_ref: string;
    rep: number;
    outcome: "pass" | "fail" | "error";
    steps_passed: number;
    steps_total: number;
  }[];
}

export type HarnessReply =
  | { op: "load"; nonce: string; scenarios_total: number }
  | { op: "begin"; nonce: string; steps_total: number; invoke: HarnessInvoke }
  | { op: "observe"; nonce: string; step_pass: boolean; next: HarnessInvoke | null }
  | { op: "verdict"; nonce: string; verdict: HarnessVerdict };

export type HarnessErrorCode = "reply_missing" | "reply_malformed" | "reply_too_large" | "exec_failed";

/** The message is the code only: a harness reply is never echoed into an error. */
export class HarnessError extends Error {
  readonly code: HarnessErrorCode;

  constructor(code: HarnessErrorCode) {
    super(code);
    this.name = "HarnessError";
    this.code = code;
  }
}

export interface HarnessClient {
  readonly nonce: string;
  load(set: HarnessSet): Promise<void>;
  begin(ref: string, rep: number): Promise<{ steps_total: number; invoke: HarnessInvoke }>;
  observe(
    ref: string,
    rep: number,
    stepIndex: number,
    observation: StepObservation,
  ): Promise<{ step_pass: boolean; next: HarnessInvoke | null }>;
  verdict(): Promise<HarnessVerdict>;
}

function expectOp<Op extends HarnessReply["op"]>(reply: HarnessReply, op: Op): Extract<HarnessReply, { op: Op }> {
  if (reply.op !== op) throw new HarnessError("reply_malformed");
  return reply as Extract<HarnessReply, { op: Op }>;
}

/**
 * One `docker exec -i` per operation (M3f-D5): the request is JSON on stdin, the reply is one JSON document on stdout.
 * Every reply is schema-checked and must echo this client's nonce; a missing, oversized, malformed or foreign reply
 * throws, so "no verdict" can never be read as a pass (the verdict half of E7).
 */
export function createHarnessClient(
  runtime: Pick<ContainerRuntime, "exec">,
  harness: ContainerHandle,
  limits: StepLimits,
  options: { nonce?: string } = {},
): HarnessClient {
  const nonce = options.nonce ?? randomBytes(8).toString("hex");

  async function call(request: HarnessRequest): Promise<HarnessReply> {
    const result = await runtime.exec(harness, {
      argv: HARNESS_EXEC_ARGV,
      stdin: JSON.stringify(request),
      timeoutMs: limits.timeoutMs,
      maxOutputBytes: limits.maxOutputBytes,
    });
    if (result.kind === "output_limit") throw new HarnessError("reply_too_large");
    if (result.kind !== "exited" || result.status !== 0) throw new HarnessError("exec_failed");
    if (result.stdout.trim() === "") throw new HarnessError("reply_missing");
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new HarnessError("reply_malformed");
    }
    if (!validateDef(HARNESS_SCHEMA, "reply", parsed).ok) throw new HarnessError("reply_malformed");
    const reply = parsed as HarnessReply;
    if (reply.nonce !== nonce) throw new HarnessError("reply_malformed");
    return reply;
  }

  return {
    nonce,
    async load(set) {
      const reply = expectOp(await call({ op: "load", nonce, set }), "load");
      if (reply.scenarios_total !== set.scenarios.length) throw new HarnessError("reply_malformed");
    },
    async begin(ref, rep) {
      const reply = expectOp(await call({ op: "begin", nonce, scenario_ref: ref, rep }), "begin");
      return { steps_total: reply.steps_total, invoke: reply.invoke };
    },
    async observe(ref, rep, stepIndex, observation) {
      const request: HarnessRequest = {
        op: "observe",
        nonce,
        scenario_ref: ref,
        rep,
        step_index: stepIndex,
        observation,
      };
      const reply = expectOp(await call(request), "observe");
      return { step_pass: reply.step_pass, next: reply.next };
    },
    async verdict() {
      const reply = expectOp(await call({ op: "verdict", nonce }), "verdict");
      if (reply.verdict.nonce !== nonce) throw new HarnessError("reply_malformed");
      return reply.verdict;
    },
  };
}
