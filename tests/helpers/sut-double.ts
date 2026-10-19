import type { ProcessResult } from "../../src/adapters/process-group.js";
import type {
  ContainerHandle,
  ContainerRuntime,
  ExecSpec,
  ImageInfo,
  OwnedResource,
} from "../../src/container/runtime.js";
import type { ContainerSpec, ImageId } from "../../src/container/spec.js";
import type { HarnessReply, HarnessRequest, HarnessSet, HarnessVerdict } from "../../src/judge/harness-protocol.js";
import { FAULTS } from "../../src/judge/round.js";
import { evaluateExpect } from "../../src/scenario/matcher.js";

export const IMAGE: ImageInfo = {
  id: `sha256:${"a".repeat(64)}` as ImageId,
  env_names: ["PATH"],
  user: "65532:65532",
  volumes: [],
};

/** What a candidate can leave behind inside one container: a file under /tmp and a background process. */
export interface SutState {
  files: Map<string, string>;
  background: Set<string>;
  dead: boolean;
}
export interface SutCall {
  container: string;
  argv: readonly string[];
  stdin: string;
  state: SutState;
}
export type Candidate = (call: SutCall) => ProcessResult;
/** Returns a corrupted reply, a raw stdout string, or null for an empty stdout. */
export type Tamper = (request: HarnessRequest, reply: HarnessReply) => HarnessReply | string | null;

export const exited = (stdout: string, status = 0): ProcessResult => ({
  kind: "exited",
  status,
  signal: null,
  stdout,
  stderr: "",
});

type Run = HarnessVerdict["runs"][number];

export interface HarnessDoubleOptions {
  /** A step whose expectation has a `json_path` (only the contradiction canary has one) is scored a pass: a judge that accepts the contradiction. */
  passJsonPath?: boolean;
}

/** The harness side of the protocol: holds the loaded set and answers load, begin, observe and verdict. */
export class HarnessDouble {
  private set: HarnessSet | null = null;
  private readonly runs = new Map<string, Run>();

  constructor(private readonly options: HarnessDoubleOptions = {}) {}

  private scenario(ref: string) {
    const found = this.set?.scenarios.find((entry) => entry.scenario_ref === ref);
    if (found === undefined) throw new Error(`harness double: unknown scenario ${ref}`);
    return found;
  }

  answer(request: HarnessRequest): HarnessReply {
    const { nonce } = request;
    switch (request.op) {
      case "load":
        this.set = request.set;
        this.runs.clear();
        return { op: "load", nonce, scenarios_total: request.set.scenarios.length };
      case "begin": {
        const scenario = this.scenario(request.scenario_ref);
        const first = scenario.steps[0];
        if (first === undefined) throw new Error("harness double: scenario without steps");
        this.runs.set(`${request.scenario_ref}#${request.rep}`, {
          scenario_ref: request.scenario_ref,
          rep: request.rep,
          outcome: "pass",
          steps_passed: 0,
          steps_total: scenario.steps.length,
        });
        return { op: "begin", nonce, steps_total: scenario.steps.length, invoke: first.invoke };
      }
      case "observe": {
        const scenario = this.scenario(request.scenario_ref);
        const step = scenario.steps[request.step_index];
        const run = this.runs.get(`${request.scenario_ref}#${request.rep}`);
        if (step === undefined || run === undefined) throw new Error("harness double: observe out of order");
        const pass =
          (this.options.passJsonPath === true && step.expect.json_path !== null) ||
          evaluateExpect({ ...step.expect, note: "" }, request.observation).pass;
        if (pass) run.steps_passed += 1;
        else run.outcome = FAULTS.has(request.observation.outcome) ? "error" : "fail";
        const next = scenario.steps[request.step_index + 1];
        return { op: "observe", nonce, step_pass: pass, next: pass && next !== undefined ? next.invoke : null };
      }
      case "verdict":
        return { op: "verdict", nonce, verdict: { schema_version: 1, nonce, runs: [...this.runs.values()] } };
    }
  }
}

export class RuntimeDouble implements ContainerRuntime {
  readonly context = "colima-test";
  /** `create:<role>:<name>`, `start:<name>`, `exec:<role>:<name>`, `remove:<name>`, `removeAllSync:<names>`. */
  readonly calls: string[] = [];
  readonly specs: ContainerSpec[] = [];
  /** Everything a candidate container was ever given. This is all the SUT ever sees. */
  readonly sutExecs: {
    container: string;
    argv: readonly string[];
    stdin: string;
    workdir: string | undefined;
    env: Readonly<Record<string, string>> | undefined;
  }[] = [];
  tamper: Tamper | null = null;
  /** The daemon cannot answer an inspect (a failed call): the state of a container is then unknown. */
  failInspect = false;
  /** What the daemon reports about a stopped container besides `Running` (`OOMKilled`, `ExitCode`, `FinishedAt`), by name. */
  readonly stopState = new Map<string, Record<string, unknown>>();
  private readonly live = new Map<string, SutState>();
  private readonly harness = new HarnessDouble();

  constructor(private readonly candidate: Candidate) {}

  /** A container made outside runJudgeRound, for the relay unit tests. */
  open(name: string): ContainerHandle {
    this.live.set(name, { files: new Map(), background: new Set(), dead: false });
    return { name, id: `id-${name}`, role: "sut" };
  }

  async endpoint() {
    return { kind: "unix" as const, local: true };
  }
  async info() {
    return { ok: true as const, server_version: "0" };
  }
  async ensureImage(): Promise<ImageInfo> {
    return IMAGE;
  }
  async imageInfo(): Promise<ImageInfo> {
    return IMAGE;
  }
  async build(): Promise<ImageInfo> {
    return IMAGE;
  }

  async create(spec: ContainerSpec): Promise<ContainerHandle> {
    this.calls.push(`create:${spec.labels.role}:${spec.name}`);
    this.specs.push(spec);
    this.live.set(spec.name, { files: new Map(), background: new Set(), dead: false });
    return { name: spec.name, id: `id-${spec.name}`, role: spec.labels.role };
  }
  async inspect(handle: ContainerHandle): Promise<unknown> {
    if (this.failInspect) throw new Error("inspect failed");
    const state = this.live.get(handle.name);
    const running = state !== undefined && !state.dead;
    return { State: { Running: running, ...(running ? {} : this.stopState.get(handle.name)) } };
  }
  async start(handle: ContainerHandle): Promise<void> {
    this.calls.push(`start:${handle.name}`);
  }
  async remove(handle: ContainerHandle): Promise<void> {
    this.calls.push(`remove:${handle.name}`);
    this.live.delete(handle.name);
  }
  async listOwned(): Promise<OwnedResource[]> {
    return [];
  }
  async removeImage(id: ImageId): Promise<void> {
    this.calls.push(`removeImage:${id}`);
  }
  removeAllSync(names: readonly string[]): void {
    this.calls.push(`removeAllSync:${names.join(",")}`);
    for (const name of names) this.live.delete(name);
  }

  async exec(handle: ContainerHandle, spec: ExecSpec): Promise<ProcessResult> {
    this.calls.push(`exec:${handle.role}:${handle.name}`);
    const stdin = typeof spec.stdin === "string" ? spec.stdin : (spec.stdin?.toString("utf8") ?? "");
    if (handle.role === "harness") return this.harnessExec(stdin);
    this.sutExecs.push({ container: handle.name, argv: spec.argv, stdin, workdir: spec.workdir, env: spec.env });
    const state = this.live.get(handle.name);
    if (state === undefined || state.dead) {
      return { kind: "exited", status: 1, signal: null, stdout: "", stderr: "container is not running" };
    }
    return this.candidate({ container: handle.name, argv: spec.argv, stdin, state });
  }

  private harnessExec(stdin: string): ProcessResult {
    const request = JSON.parse(stdin) as HarnessRequest;
    const reply = this.harness.answer(request);
    const out = this.tamper === null ? reply : this.tamper(request, reply);
    const stdout = out === null ? "" : typeof out === "string" ? out : `${JSON.stringify(out)}\n`;
    return { kind: "exited", status: 0, signal: null, stdout, stderr: "" };
  }
}
