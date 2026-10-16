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
import { FakeDocker } from "./fake-docker.js";
import { addImage, type FakeExecCall } from "./fake-docker-core.mjs";
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
}

export interface ImplementerRig {
  s: SealedItem;
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
  writeFileSync(
    join(fx.location.dir, "config.toml"),
    [
      fx.baseConfig.replace(
        'implementer = { vendor = "claude" }',
        `implementer = { vendor = "claude", model = "${MODEL}" }`,
      ),
      "[judge]",
      `docker_context = "${IMPLEMENTER_CONTEXT}"`,
      "",
      "[implementer]",
      `image = "${IMPLEMENTER_IMAGE}"`,
      "",
    ].join("\n"),
  );

  const trees = new Map<string, LocalTreeContainer>();
  const fake = new FakeDocker({
    exec: (call) =>
      call.argv.join("\n") === CONTAINER_PROBE_ARGV.join("\n")
        ? { status: 0, stdout: CLEAN_PROBE, stderr: "" }
        : containerFor(trees, call).exec(call),
  });
  addImage(fake.state, IMPLEMENTER_IMAGE, { env: ["PATH=/usr/local/bin:/usr/bin", "NODE_VERSION=22"] });

  const measured = (): number =>
    fx.ledger.readVerified().filter((e) => e.type === "isolation.measured" && e.payload.stage === "implementer").length;
  const spy = spyRuntime(fakeRuntime(fake, IMPLEMENTER_CONTEXT), measured);
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
    env: key === null ? {} : { OMF_IMPLEMENTER_API_KEY: key },
    session: (credential) => {
      sessions += 1;
      return scriptSession(spy.runtime, script(s.f.workId, sessions), {
        requests,
        ...(options.cost === undefined ? {} : { cost: options.cost }),
        ...(options.log === undefined ? {} : { log: options.log }),
      })(credential);
    },
  });

  const refs = (): string[] =>
    gitIn(fx.repo, "for-each-ref", "--format=%(refname)", "refs/heads/omf")
      .split("\n")
      .filter((line) => line !== "");
  return {
    s,
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
