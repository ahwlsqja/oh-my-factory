// OMF judge harness (spec §5.5, M3f). It runs inside the harness container, one `docker exec -i` per operation:
// a JSON request on stdin, one JSON reply on stdout, state in the tmpfs /state (first argument overrides, for host tests).
// It holds the scenarios the host loaded, says which step to run next, and judges each observation with OMF's own
// matcher, so hostile SUT output is parsed here and never on the host. A refusal is exit status 2, an empty stdout
// and one "refused: <code>" line on stderr; the host reads that as a failure, never as a reply.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateExpect } from "./matcher.mjs";

const STATE_DIR = process.argv[2] ?? "/state";
const STATE_FILE = join(STATE_DIR, "state.json");
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_SCENARIOS = 100;
const MAX_STEPS = 12;
const MAX_ARGV = 64;
const MAX_REP = 1000;
const HEX16 = /^[0-9a-f]{16}$/;
const OBSERVED = new Set(["exited", "signaled", "timeout", "output_limit", "error", "refused"]);

class Refusal extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isScalar = (value) => value === null || ["string", "number", "boolean"].includes(typeof value);

async function readRequest() {
  const chunks = [];
  let total = 0;
  let over = false;
  // Drain everything even past the cap, so the writer never sees EPIPE; only the first MAX bytes are kept.
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total <= MAX_REQUEST_BYTES) chunks.push(chunk);
    else over = true;
  }
  if (over) throw new Refusal("request_too_large");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Refusal("request_malformed");
  }
}

function readState() {
  let text;
  try {
    text = readFileSync(STATE_FILE, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Refusal("state_unreadable");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Refusal("state_unreadable");
  }
}

function writeState(state) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const temp = `${STATE_FILE}.tmp`;
  writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
  renameSync(temp, STATE_FILE);
}

function checkExpect(expect) {
  if (!isObject(expect)) throw new Refusal("set_invalid");
  const { exit_code: code, stdout_matches: match, json_path: paths } = expect;
  const codeOk = code === null || (Number.isInteger(code) && code >= 0 && code <= 255);
  const matchOk =
    match === null ||
    (isObject(match) &&
      ((match.kind === "exact" && typeof match.text === "string") ||
        (match.kind === "anchored" && typeof match.pattern === "string")));
  const pathsOk = paths === null || (isObject(paths) && Object.values(paths).every(isScalar));
  // An expectation with nothing to check would pass anything: intake refuses it, and so does the harness.
  if (!codeOk || !matchOk || !pathsOk || (code === null && match === null && paths === null)) {
    throw new Refusal("set_invalid");
  }
}

function checkSet(set) {
  if (!isObject(set) || set.schema_version !== 1 || !Array.isArray(set.scenarios)) throw new Refusal("set_invalid");
  if (set.scenarios.length === 0 || set.scenarios.length > MAX_SCENARIOS) throw new Refusal("set_invalid");
  const seen = new Set();
  for (const scenario of set.scenarios) {
    const ok =
      isObject(scenario) &&
      typeof scenario.scenario_ref === "string" &&
      HEX16.test(scenario.scenario_ref) &&
      !seen.has(scenario.scenario_ref) &&
      Array.isArray(scenario.steps) &&
      scenario.steps.length > 0 &&
      scenario.steps.length <= MAX_STEPS;
    if (!ok) throw new Refusal("set_invalid");
    seen.add(scenario.scenario_ref);
    for (const step of scenario.steps) {
      const invoke = isObject(step) ? step.invoke : null;
      const invokeOk =
        isObject(invoke) &&
        Array.isArray(invoke.argv) &&
        invoke.argv.length <= MAX_ARGV &&
        invoke.argv.every((element) => typeof element === "string") &&
        typeof invoke.stdin === "string";
      if (!invokeOk) throw new Refusal("set_invalid");
      checkExpect(step.expect);
    }
  }
}

function checkObservation(observation) {
  const ok =
    isObject(observation) &&
    OBSERVED.has(observation.outcome) &&
    (observation.outcome !== "exited" ||
      (Number.isInteger(observation.exit_code) && typeof observation.stdout === "string")) &&
    (observation.outcome !== "signaled" || typeof observation.signal === "string") &&
    (observation.outcome !== "refused" || typeof observation.code === "string");
  if (!ok) throw new Refusal("request_malformed");
}

/** exited: judged by the matcher. A signal, a timeout and the output limit are the candidate's doing: a failing step. error and refused are a runtime fault. */
function judgeStep(step, observation) {
  switch (observation.outcome) {
    case "exited":
      return evaluateExpect(step.expect, observation).pass ? "pass" : "fail";
    case "signaled":
    case "timeout":
    case "output_limit":
      return "fail";
    default:
      return "error";
  }
}

const invokeOf = (step) => ({ argv: step.invoke.argv, stdin: step.invoke.stdin });
const runKey = (request) => `${request.scenario_ref}#${request.rep}`;

function scenarioOf(state, request) {
  const scenario = state.set.scenarios.find((candidate) => candidate.scenario_ref === request.scenario_ref);
  if (scenario === undefined) throw new Refusal("unknown_scenario");
  if (!Number.isInteger(request.rep) || request.rep < 1 || request.rep > MAX_REP)
    throw new Refusal("request_malformed");
  return scenario;
}

function handle(request) {
  if (!isObject(request) || typeof request.nonce !== "string" || !HEX16.test(request.nonce)) {
    throw new Refusal("request_malformed");
  }
  const nonce = request.nonce;
  const state = readState();
  if (request.op === "load") {
    if (state !== null) throw new Refusal("already_loaded");
    checkSet(request.set);
    writeState({ nonce, set: request.set, runs: {} });
    return { op: "load", nonce, scenarios_total: request.set.scenarios.length };
  }
  if (!["begin", "observe", "verdict"].includes(request.op)) throw new Refusal("unknown_op");
  if (state === null) throw new Refusal("not_loaded");
  if (nonce !== state.nonce) throw new Refusal("nonce_mismatch");

  if (request.op === "begin") {
    const scenario = scenarioOf(state, request);
    const key = runKey(request);
    if (Object.hasOwn(state.runs, key)) throw new Refusal("duplicate_run");
    state.runs[key] = { scenario_ref: request.scenario_ref, rep: request.rep, next: 0, steps_passed: 0, outcome: null };
    writeState(state);
    return { op: "begin", nonce, steps_total: scenario.steps.length, invoke: invokeOf(scenario.steps[0]) };
  }

  if (request.op === "observe") {
    const scenario = scenarioOf(state, request);
    const run = state.runs[runKey(request)];
    if (run === undefined) throw new Refusal("run_not_begun");
    if (run.outcome !== null) throw new Refusal("run_finished");
    if (request.step_index !== run.next) throw new Refusal("step_out_of_order");
    checkObservation(request.observation);
    const result = judgeStep(scenario.steps[run.next], request.observation);
    let next = null;
    if (result === "pass") {
      run.steps_passed += 1;
      run.next += 1;
      if (run.next === scenario.steps.length) run.outcome = "pass";
      else next = invokeOf(scenario.steps[run.next]);
    } else {
      run.outcome = result;
    }
    writeState(state);
    return { op: "observe", nonce, step_pass: result === "pass", next };
  }

  const runs = Object.values(state.runs)
    .sort((a, b) => (a.scenario_ref < b.scenario_ref ? -1 : a.scenario_ref > b.scenario_ref ? 1 : a.rep - b.rep))
    .map((run) => ({
      scenario_ref: run.scenario_ref,
      rep: run.rep,
      // A run that was begun and never finished is an error, never a pass.
      outcome: run.outcome ?? "error",
      steps_passed: run.steps_passed,
      steps_total: state.set.scenarios.find((candidate) => candidate.scenario_ref === run.scenario_ref).steps.length,
    }));
  return { op: "verdict", nonce, verdict: { schema_version: 1, nonce, runs } };
}

try {
  const request = await readRequest();
  process.stdout.write(`${JSON.stringify(handle(request))}\n`);
} catch (error) {
  process.stderr.write(`refused: ${error instanceof Refusal ? error.code : "internal_error"}\n`);
  process.exitCode = 2;
}
