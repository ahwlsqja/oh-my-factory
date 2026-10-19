import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ProcessResult } from "../../src/adapters/process-group.js";
import { HARNESS_BASE, SUT_BASE } from "./container-fixture.js";
import { addImage, type FakeCall, type FakeHooks, type FakeState, handle, newState } from "./fake-docker-core.mjs";
import { makeTempDir } from "./tmp.js";

/** Structurally the `DockerRunner` of src/container/docker-cli.ts. */
export type FakeRunner = (
  argv: readonly string[],
  options: {
    stdin?: string | Buffer;
    timeoutMs: number;
    maxOutputBytes: number;
    env?: Readonly<Record<string, string>>;
  },
) => Promise<ProcessResult>;

/** The verbs that build, pull, create, start or run something: what an offline test must see none of when a guard refuses. */
export const MUTATING_VERBS: ReadonlySet<string> = new Set(["build", "pull", "create", "start", "exec"]);

/** `create`, `exec`, `container inspect`, `context inspect`: the verb of a call, without `--context <name>`. */
export function verbOf(argv: readonly string[]): string {
  const rest = argv[0] === "--context" ? argv.slice(2) : argv;
  return ["container", "image", "context"].includes(rest[0] ?? "") ? rest.slice(0, 2).join(" ") : (rest[0] ?? "");
}

/** A daemon that already holds the two pinned base images (both with an `ENV` of their own, as real bases have). */
export function defaultState(contexts?: Record<string, string>): FakeState {
  const state = newState(contexts === undefined ? {} : { contexts });
  const env = ["PATH=/usr/local/bin:/usr/bin", "NODE_VERSION=22"];
  addImage(state, SUT_BASE, { env });
  addImage(state, HARNESS_BASE, { env });
  return state;
}

export interface FakeDockerOptions {
  contexts?: Record<string, string>;
  /** Answer for `docker exec` into a running container. Default: exit 0, no output. */
  exec?: FakeHooks["exec"];
  /** Edits the inspect document of a container; the way a test models a deviation from the golden argv. */
  tamper?: FakeHooks["inspect"];
}

/** An in-memory docker for offline tests: `run` and `runSync` plug into `createDockerRuntime`. */
export class FakeDocker {
  readonly state: FakeState;
  /** Answers a call instead of the daemon (a timeout, a missing binary); null lets the daemon answer. */
  intercept: ((argv: readonly string[]) => ProcessResult | null) | null = null;
  /** Awaited before a call is answered: a test that holds a call open (a killed process never gets its answer) returns a pending promise. */
  gate: ((argv: readonly string[]) => Promise<void> | null) | null = null;
  private readonly hooks: FakeHooks;

  constructor(options: FakeDockerOptions = {}) {
    this.state = defaultState(options.contexts);
    this.hooks = {
      ...(options.exec === undefined ? {} : { exec: options.exec }),
      ...(options.tamper === undefined ? {} : { inspect: options.tamper }),
    };
  }

  readonly run: FakeRunner = async (argv, options) => {
    await this.gate?.(argv);
    const answer = this.intercept?.(argv) ?? null;
    if (answer !== null) {
      this.state.calls.push({ argv: [...argv], context: null, stdin_b64: null });
      return answer;
    }
    const result = handle(this.state, argv, options.stdin ?? null, this.hooks, options.env ?? {});
    return { kind: "exited", status: result.status, signal: null, stdout: result.stdout, stderr: result.stderr };
  };

  readonly runSync = (argv: readonly string[]): { status: number | null; stdout: string; stderr: string } =>
    handle(this.state, argv, null, this.hooks);

  /** The verb of every call so far, in order. */
  verbs(): string[] {
    return this.state.calls.map((call) => verbOf(call.argv));
  }

  calls(verb: string): FakeCall[] {
    return this.state.calls.filter((call) => verbOf(call.argv) === verb);
  }
}

const SHIM_MAIN = fileURLToPath(new URL("./fake-docker-bin/docker.mjs", import.meta.url));

export interface FakeDockerBin {
  dir: string;
  statePath: string;
  /** A PATH value with this docker first; pass it as the client's `PATH`. */
  path: string;
  state(): FakeState;
  update(change: (state: FakeState) => void): void;
}

/**
 * A stateful `docker` program on PATH, for the tests that need state across processes (the doctor probe, the kill test).
 * The wrapper is generated in a private temp dir next to its state file, because the client is started with PATH and
 * DOCKER_CONFIG only and a state path could not travel in the environment. It is a CommonJS script on purpose: outside the
 * package it needs no package.json, and `env` adds no variable to the client's environment. With `hooks` (an absolute
 * path to an .mjs module) the program answers `docker exec` through it.
 */
export function fakeDockerBin(options: { hooks?: string } = {}): FakeDockerBin {
  const dir = makeTempDir("omf-fake-docker-");
  const statePath = join(dir, "fake-docker-state.json");
  const wrapper = join(dir, "docker");
  writeFileSync(
    wrapper,
    [
      "#!/usr/bin/env node",
      `process.argv.splice(2, 0, ${JSON.stringify(statePath)});`,
      `import(${JSON.stringify(pathToFileURL(SHIM_MAIN).href)});`,
      "",
    ].join("\n"),
  );
  chmodSync(wrapper, 0o755);
  writeFileSync(statePath, JSON.stringify(defaultState()));
  // The path travels as a file URL in a sidecar file; see docker.mjs. The module's own config is written by its owner into `dir`.
  if (options.hooks !== undefined) writeFileSync(`${statePath}.hooks`, pathToFileURL(options.hooks).href);
  const read = (): FakeState => JSON.parse(readFileSync(statePath, "utf8")) as FakeState;
  return {
    dir,
    statePath,
    path: `${dir}${delimiter}${process.env.PATH ?? ""}`,
    state: read,
    update(change) {
      const state = read();
      change(state);
      writeFileSync(statePath, JSON.stringify(state));
    },
  };
}

/**
 * A container a killed pass left behind: `omf.owner` and `omf.run` labels and an OMF name, nothing else. The name carries the
 * role (`omf-author-<run>-1-1`), the sweeps find it through the labels the daemon lists.
 */
export function plantOwnedContainer(state: FakeState, role: string, runId: string, workId = "w-0123456789ab"): string {
  const name = `omf-${role}-${runId}-1-1`;
  state.containers[name] = {
    name,
    running: true,
    labels: { "omf.owner": "omf", "omf.work": workId, "omf.run": runId, "omf.round": "1", "omf.role": role },
  };
  return name;
}
