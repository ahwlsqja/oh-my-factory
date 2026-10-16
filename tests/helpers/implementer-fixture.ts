import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONTAINER_PROBE_ARGV } from "../../src/container/measure.js";
import type { ContainerRuntime } from "../../src/container/runtime.js";
import type { LedgerEvent } from "../../src/core/ledger.js";
import type { InterfaceContract } from "../../src/decision/types.js";
import { type Credential, containsCredential, redact } from "../../src/implementer/credential.js";
import type { ImplementerSession, SessionRequest } from "../../src/implementer/session.js";
import { type ImplementerStations, implementerStations } from "../../src/implementer/station.js";
import type { FeedbackSlot } from "../../src/judge/round-state.js";
import type { StationContext } from "../../src/work/sequencer.js";
import { CONTRACT } from "./decision-fixture.js";
import { FakeDocker, verbOf } from "./fake-docker.js";
import { addImage, type FakeExecCall, type FakeHooks, type FakeResult } from "./fake-docker-core.mjs";
import { fakeRuntime } from "./fake-runtime.js";
import { LocalTreeContainer } from "./implementer-container.js";
import { stationCtx } from "./judge-seed.js";
import { CLEAN_PROBE } from "./measure-fixture.js";
import { DEFAULT_SPECS, type SealedItem, seedSealedItem } from "./scenario-fixture.js";
import { commitAll, gitIn } from "./tmp.js";

export const IMPLEMENTER_IMAGE = `example.test/omf/implementer@sha256:${"c".repeat(64)}`;
/** A context the fake daemon already knows (a local unix socket). */
export const IMPLEMENTER_CONTEXT = "colima-omf-m3f";
export const MODEL = "claude-test-1";
/** Built at run time: no literal key shape sits in the repository. */
export const SENTINEL_KEY = ["sk", "ant", "sentinel", "k".repeat(28)].join("-");
/** The test command names a tracked file, so `explicitTestPaths` has something to find. */
export const TEST_CONTRACT: InterfaceContract = { ...CONTRACT, test_command: ["sh", "tests/run.sh"] };

/** The key of the matrix tests; an invented shape, never a real credential. */
export const FAKE_KEY = SENTINEL_KEY;

export interface CommitScript {
  message: string;
  /** `null` deletes the path. */
  files: Readonly<Record<string, string | null>>;
}
export interface StubBehavior {
  /** Made in order, in `/work`, with a plain `git commit` (the prepared repository carries the identity). */
  commits: readonly CommitScript[];
  /** Files left in `/work` and never committed. */
  uncommitted?: Readonly<Record<string, string>>;
  /** Files left under the container's temp directory; keys are relative to it. */
  tmpFiles?: Readonly<Record<string, string>>;
  /** Raw text the session prints, as if the agent had echoed it. */
  log?: string;
}

const quoted = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/** The shell a `StubBehavior` stands for. Test data, run for real by `LocalTreeContainer`; never product code. */
export function behaviorScript(behavior: StubBehavior): string {
  const lines = ["set -e"];
  const write = (target: string, text: string): void => {
    lines.push(`mkdir -p "$(dirname ${target})"`, `printf '%s' ${quoted(text)} > ${target}`);
  };
  for (const commit of behavior.commits) {
    for (const [path, text] of Object.entries(commit.files)) {
      if (text === null) lines.push(`git rm -q -f --ignore-unmatch -- ${quoted(path)}`);
      else {
        write(quoted(path), text);
        lines.push(`git add -- ${quoted(path)}`);
      }
    }
    lines.push(`git commit -q --allow-empty -m ${quoted(commit.message)}`);
  }
  for (const [path, text] of Object.entries(behavior.uncommitted ?? {})) write(quoted(path), text);
  for (const [path, text] of Object.entries(behavior.tmpFiles ?? {})) write(`"$OMF_TMP"/${quoted(path)}`, text);
  return lines.join("\n");
}

/**
 * The script the stub implementer runs inside the container, from `/work`: a plan-only first commit, then one code commit.
 * `marker` makes two rounds produce different commits.
 */
export function goodScript(workId: string, marker = "one"): string {
  const dir = `.omf/${workId}`;
  return [
    "set -e",
    `mkdir -p ${dir} src`,
    `printf 'Plan: add src/feature.js (${marker})\\n' > ${dir}/plan.md`,
    `git add ${dir}/plan.md`,
    'git commit -q -m "plan"',
    `printf 'module.exports = "${marker}";\\n' > src/feature.js`,
    "git add src/feature.js",
    'git commit -q -m "feature"',
  ].join("\n");
}

/** One `docker exec` as the runtime saw it. `measured` = implementer measurements already in the ledger at that moment. */
export interface ExecRecord {
  name: string;
  argv: readonly string[];
  secret: string | null;
  measured: number;
}

export interface RuntimeSpy {
  runtime: ContainerRuntime;
  execs: ExecRecord[];
  /** The next this many `remove` calls fail, as a daemon that refuses would. */
  failRemoves: number;
}

export function spyRuntime(inner: ContainerRuntime, measured: () => number): RuntimeSpy {
  const spy: RuntimeSpy = { runtime: inner, execs: [], failRemoves: 0 };
  spy.runtime = {
    ...inner,
    exec: (handle, spec) => {
      spy.execs.push({ name: handle.name, argv: spec.argv, secret: spec.secret?.name ?? null, measured: measured() });
      return inner.exec(handle, spec);
    },
    remove: async (handle) => {
      if (spy.failRemoves > 0) {
        spy.failRemoves -= 1;
        throw new Error("remove refused");
      }
      await inner.remove(handle);
    },
  };
  return spy;
}

/**
 * A model-free implementer: runs `script` with `sh -c` in the container's `/work` through the runtime and hands over the
 * credential exactly as the real adapter does (as `ExecSpec.secret`). `log` lets a test make the raw log mention the key.
 */
export function scriptSession(
  runtime: ContainerRuntime,
  script: string,
  options: { cost?: number | null; log?: (key: string) => string; requests?: SessionRequest[] } = {},
): (credential: Credential) => ImplementerSession {
  return (credential) => ({
    id: "script",
    vendor: "stub",
    model: null,
    async run(container, request) {
      options.requests?.push(request);
      const started = Date.now();
      const result = await runtime.exec(container, {
        argv: ["sh", "-c", script],
        workdir: "/work",
        secret: credential,
        timeoutMs: request.timeoutMs,
        maxOutputBytes: request.maxOutputBytes,
      });
      const durationMs = Date.now() - started;
      if (result.kind !== "exited" || result.status !== 0) {
        return {
          ok: false,
          code: result.kind === "timeout" ? "timeout" : "nonzero_exit",
          log: "",
          credential_hits: 0,
          durationMs,
        };
      }
      const raw = `${result.stdout}${result.stderr}${options.log?.(credential.reveal()) ?? ""}`;
      return {
        ok: true,
        log: redact(raw, credential),
        credential_hits: containsCredential(raw, credential) ? 1 : 0,
        notes: "stub finished",
        cost_micro_usd: options.cost === undefined ? 1234 : options.cost,
        durationMs,
      };
    },
  });
}

export interface RigOptions {
  /** The script of the stub implementer, by work id and the number of the session (1 for the first S3 of the rig). */
  script?: (workId: string, session: number) => string;
  /** The key, set in the OMF environment as OMF_IMPLEMENTER_API_KEY (the only variable the station reads); null leaves it unset. Default `SENTINEL_KEY`. */
  key?: string | null;
  /** Feedback texts the slot has released so far. */
  released?: readonly string[];
  cost?: number | null;
  log?: (key: string) => string;
  /** The whole environment the key is read from; wins over `key`. */
  env?: NodeJS.ProcessEnv;
  /** `[implementer] image`; null leaves it unset. Default `IMPLEMENTER_IMAGE`. */
  image?: string | null;
  /** `[judge] docker_context`; null leaves it unset and gives the runtime no context. Default `IMPLEMENTER_CONTEXT`. */
  context?: string | null;
  /** `docker info` fails with this text on stderr (a daemon that is down). */
  info?: { ok: false; failure: string };
  /** false: the context's endpoint is a tcp address, not a local socket. */
  local?: boolean;
  /** A data-driven stub implementer; wins over `script`. `canary` is one canary of the sealed set. */
  behavior?: (workId: string, canary: string) => StubBehavior;
  /** Asked before the container double for every exec; null lets the double answer. */
  execFault?: (call: FakeExecCall) => FakeResult | null;
  /** Replaces the scripted session entirely. */
  session?: (credential: Credential) => ImplementerSession;
  /** Edits the inspect document of a container: a deviation from the golden. */
  tamper?: FakeHooks["inspect"];
  /** Extra lines appended to the `[implementer]` table. */
  implementerToml?: string;
}

export interface ImplementerRig {
  s: SealedItem;
  /** The same object as `s`; the matrix files read `rig.l.f`. */
  l: SealedItem;
  /** A canary of the sealed set. It sits in the vault, never in the repository. */
  canary: string;
  workId: string;
  repo: string;
  itemDir: string;
  fake: FakeDocker;
  spy: RuntimeSpy;
  stations: ImplementerStations;
  /** What every session was asked, in order. */
  requests: SessionRequest[];
  /** What `ctx.recordSpend` received, in order. */
  spends: (number | null)[];
  ctx(over?: Partial<StationContext>): StationContext;
  events(type: string): LedgerEvent[];
  /** Commits `files` to the user's repository, as a person would before running the line. */
  commit(files: Record<string, string>): void;
  /** The head sha `refs/heads/omf/<work-id>` holds in the user's repository, or null. */
  branch(): string | null;
  /** Every ref under `refs/heads/omf/` of the user's repository. */
  omfRefs(): string[];
}

/** The only place that knows how Task 5's double is built: one local tree per container name. */
function containerFor(trees: Map<string, LocalTreeContainer>, call: FakeExecCall): LocalTreeContainer {
  let tree = trees.get(call.name);
  if (tree === undefined) {
    tree = new LocalTreeContainer();
    trees.set(call.name, tree);
  }
  return tree;
}

/**
 * The whole S3 over a fake docker: the real station, the real runtime adapter and measurement, real git, a sealed item with
 * canaries in its vault, a user repository, and the stub implementer. Nothing here talks to a model or a daemon.
 */
export function implementerRig(options: RigOptions = {}): ImplementerRig {
  const s = seedSealedItem(DEFAULT_SPECS, { contract: TEST_CONTRACT });
  const { fx } = s.f;
  mkdirSync(join(fx.repo, "tests"), { recursive: true });
  writeFileSync(join(fx.repo, "tests", "run.sh"), "exit 0\n");
  commitAll(fx.repo, "add the test script");

  const key = options.key === undefined ? SENTINEL_KEY : options.key;
  const canary = s.scenarios[0]?.canary ?? "";
  if (canary === "") throw new Error("the sealed fixture has no scenario canary");
  const context = options.context === undefined ? IMPLEMENTER_CONTEXT : options.context;
  const image = options.image === undefined ? IMPLEMENTER_IMAGE : options.image;
  writeFileSync(
    join(fx.location.dir, "config.toml"),
    [
      fx.baseConfig.replace(
        'implementer = { vendor = "claude" }',
        `implementer = { vendor = "claude", model = "${MODEL}" }`,
      ),
      ...(context === null ? [] : ["[judge]", `docker_context = "${context}"`, ""]),
      "[implementer]",
      ...(image === null ? [] : [`image = "${image}"`]),
      ...(options.implementerToml === undefined ? [] : [options.implementerToml.trimEnd()]),
      "",
    ].join("\n"),
  );

  const trees = new Map<string, LocalTreeContainer>();
  const fake = new FakeDocker({
    contexts: {
      fake: "unix:///var/run/omf-fake.sock",
      [IMPLEMENTER_CONTEXT]: options.local === false ? "tcp://192.0.2.10:2375" : "unix:///var/run/omf-fake-colima.sock",
    },
    ...(options.tamper === undefined ? {} : { tamper: options.tamper }),
    exec: (call) => {
      const fault = options.execFault?.(call) ?? null;
      if (fault !== null) return fault;
      return call.argv.join("\n") === CONTAINER_PROBE_ARGV.join("\n")
        ? { status: 0, stdout: CLEAN_PROBE, stderr: "" }
        : containerFor(trees, call).exec(call);
    },
  });
  if (options.info !== undefined) {
    const { failure } = options.info;
    fake.intercept = (argv) =>
      verbOf(argv) === "info" ? { kind: "exited", status: 1, signal: null, stdout: "", stderr: failure } : null;
  }
  addImage(fake.state, IMPLEMENTER_IMAGE, { env: ["PATH=/usr/local/bin:/usr/bin", "NODE_VERSION=22"] });

  const measured = (): number =>
    fx.ledger.readVerified().filter((e) => e.type === "isolation.measured" && e.payload.stage === "implementer").length;
  const spy = spyRuntime(fakeRuntime(fake, context), measured);
  const requests: SessionRequest[] = [];
  const spends: (number | null)[] = [];
  const released = options.released ?? [];
  const feedback: FeedbackSlot = { put: () => {}, take: () => null, released: () => [...released] };
  const script = options.script ?? ((workId: string) => goodScript(workId));
  let sessions = 0;
  const stations = implementerStations({
    location: fx.location,
    runtime: spy.runtime,
    feedback,
    env: options.env ?? (key === null ? {} : { OMF_IMPLEMENTER_API_KEY: key }),
    session:
      options.session ??
      ((credential) => {
        sessions += 1;
        const behavior = options.behavior?.(s.f.workId, canary);
        const printed = behavior?.log;
        const log = printed === undefined ? options.log : (): string => printed;
        return scriptSession(
          spy.runtime,
          behavior === undefined ? script(s.f.workId, sessions) : behaviorScript(behavior),
          {
            requests,
            ...(options.cost === undefined ? {} : { cost: options.cost }),
            ...(log === undefined ? {} : { log }),
          },
        )(credential);
      }),
  });

  const refs = (): string[] =>
    gitIn(fx.repo, "for-each-ref", "--format=%(refname)", "refs/heads/omf")
      .split("\n")
      .filter((line) => line !== "");
  return {
    s,
    l: s,
    canary,
    workId: s.f.workId,
    repo: fx.repo,
    itemDir: s.f.item.dir,
    fake,
    spy,
    stations,
    requests,
    spends,
    ctx: (over = {}) =>
      stationCtx(s, {
        round: 1,
        recordSpend: (micro) => {
          spends.push(micro);
        },
        ...over,
      }),
    events: (type) => fx.ledger.readVerified().filter((event) => event.type === type),
    commit(files) {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(fx.repo, path)), { recursive: true });
        writeFileSync(join(fx.repo, path), text);
      }
      commitAll(fx.repo, "add fixtures");
    },
    branch: () => {
      const out = gitIn(fx.repo, "for-each-ref", "--format=%(objectname)", `refs/heads/omf/${s.f.workId}`).trim();
      return out === "" ? null : out;
    },
    omfRefs: refs,
  };
}

export type ImplementerRigOptions = RigOptions;
/** The name the matrix files use for `implementerRig`. */
export const setupImplementer = (options: RigOptions = {}): ImplementerRig => implementerRig(options);
