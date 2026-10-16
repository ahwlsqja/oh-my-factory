import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { CONTAINER_PROBE_ARGV } from "../../src/container/measure.js";
import type { ContainerRuntime } from "../../src/container/runtime.js";
import { Ledger } from "../../src/core/ledger.js";
import { CREDENTIAL_ENV, CREDENTIAL_SOURCE_ENV, type Credential, redact } from "../../src/implementer/credential.js";
import type { ImplementerFailureCode, ImplementerSession, SessionOutcome } from "../../src/implementer/session.js";
import { implementerStations } from "../../src/implementer/station.js";
import { recordStageMeasurement } from "../../src/isolation/record.js";
import { foldSeals } from "../../src/scenario/events.js";
import type { StationId } from "../../src/work/line-types.js";
import { type Station, runLine } from "../../src/work/sequencer.js";
import type { ProcessResult } from "../../src/adapters/process-group.js";
import type { FakeDocker } from "./fake-docker.js";
import { addImage } from "./fake-docker-core.mjs";
import { measurement } from "./gate3-parts.js";
import { type JudgeLineFixture, setupJudgeLine } from "./judge-line.js";
import { finished } from "./line.js";
import { type Finished, type SeamRun } from "./line-m3f.js";
import { LocalTreeContainer } from "./implementer-container.js";
import { BUGGY, FIXED, testFile } from "./prove-fixture.js";
import { commitAll, gitIn } from "./tmp.js";

/** Printable, under 512 characters, and shaped like nothing a scanner or a person would take for a real key. */
export const SENTINEL_KEY = "omf-sentinel-key-9f3a1c7e5b2d4a60c8";

/**
 * What the stub implementer does inside the container (a `sh` script run in `/work`, which is a container-local git
 * repository of the user's base files). Every behaviour first shows that the process holds the key, then prints it once,
 * as a benign `env` call would.
 * - good: commits the plan alone, then the fix and its test.
 * - leak_then_remove: also commits the key in a scratch file and removes it in the next commit; only history holds it.
 * - fail_after_print: prints the key and exits non-zero.
 */
export type Behavior = "good" | "leak_then_remove" | "fail_after_print";

export function scriptFor(workId: string, behavior: Behavior): string[] {
  const plan = `.omf/${workId}/plan.md`;
  const lines = ["set -eu", 'echo "SAW_KEY_LENGTH=${#ANTHROPIC_API_KEY}"', 'echo "token=$ANTHROPIC_API_KEY"'];
  if (behavior === "fail_after_print") return ["sh", "-c", [...lines, "exit 3"].join("\n")];
  lines.push(
    `mkdir -p ".omf/${workId}" src tests`,
    `printf '%s\\n' 'Plan: make add return the sum.' > "${plan}"`,
    `git add "${plan}"`,
    "git commit -q -m plan",
  );
  if (behavior === "leak_then_remove") {
    lines.push(
      "printf '%s\\n' \"$ANTHROPIC_API_KEY\" > scratch.txt",
      "git add scratch.txt",
      'git commit -q -m "scratch notes"',
      "git rm -q scratch.txt",
      'git commit -q -m "remove scratch notes"',
    );
  }
  lines.push(
    `cat > src/calc.mjs <<'OMF_EOF'\n${FIXED}OMF_EOF`,
    `cat > tests/calc.test.mjs <<'OMF_EOF'\n${testFile("assert.equal(add(1, 2), 3);")}OMF_EOF`,
    "git add src/calc.mjs tests/calc.test.mjs",
    'git commit -q -m "fix add"',
  );
  return ["sh", "-c", lines.join("\n")];
}

function failureCode(result: ProcessResult): ImplementerFailureCode {
  if (result.kind === "exited") return "nonzero_exit";
  return result.kind === "timeout" || result.kind === "output_limit" ? result.kind : "spawn_failed";
}

/**
 * A session that runs `script` in the container with the credential as the exec's secret. `createStubSession` runs a
 * script without the key; this one hands it over exactly as the Claude adapter does, so the double confirms that the
 * container process saw it. Like the adapter it scans the raw log, counts hits, and returns only the redacted log.
 */
export function keyedScriptSession(
  runtime: ContainerRuntime,
  credential: Credential,
  script: readonly string[],
): ImplementerSession {
  return {
    id: "line-script",
    vendor: "stub",
    model: null,
    async run(container, request): Promise<SessionOutcome> {
      const started = Date.now();
      const result = await runtime.exec(container, {
        argv: script,
        workdir: "/work",
        secret: credential,
        timeoutMs: request.timeoutMs,
        maxOutputBytes: request.maxOutputBytes,
      });
      const durationMs = Date.now() - started;
      const raw = result.kind === "error" ? "" : `${result.stdout}${result.stderr}`;
      const credential_hits = raw.split(credential.reveal()).length - 1;
      const log = redact(raw, credential);
      if (result.kind === "exited" && result.status === 0) {
        return { ok: true, log, credential_hits, notes: null, cost_micro_usd: 0, durationMs };
      }
      return { ok: false, code: failureCode(result), log, credential_hits, durationMs };
    },
  };
}

export interface ImplementerLineOptions {
  behavior?: Behavior;
  /** The SEAM: after the real S3, append the author measurement M3h will make. A statement by this test, not a measured container. */
  seam?: boolean;
  key?: string;
}
export interface ImplementerLineRun extends SeamRun {
  workId: string;
  /** The user's repository, which the line exports from and publishes one branch into. */
  userRepo: string;
  mainBefore: string;
  /** The argv of every exec into an implementer container that carried the secret. */
  secretExecs: string[][];
  key: string;
}

const sameArgv = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((part, index) => part === b[index]);

/** `refs/heads/omf/*` of a repository: the only ref the implementer line may add. */
export function omfRefs(repo: string): string[] {
  return gitIn(repo, "for-each-ref", "--format=%(refname)", "refs/heads/omf")
    .split("\n")
    .filter((line) => line !== "");
}

function withAuthorMeasurement(jl: JudgeLineFixture, inner: Station): Station {
  return {
    id: "S3",
    async run(ctx) {
      const result = await inner.run(ctx);
      if (result.kind !== "ok") return result;
      const ledger = new Ledger(jl.l.f.fx.location.dir, ctx.now);
      const scope = { goal_id: ctx.goalId, work_id: ctx.workId, run_id: ctx.runId };
      const seal = foldSeals(ledger.readVerified(), { goal_id: ctx.goalId, work_id: ctx.workId }).latest;
      if (seal === null) throw new Error("the seam needs a standing seal");
      recordStageMeasurement(ledger, scope, ctx.item.dir, measurement("author", "L2", 1), {
        seal_seq: seal.seq,
        set_sha256: seal.set_sha256,
      });
      return result;
    },
  };
}

/**
 * One `runLine` over the real S2, S3, S4, S5, S6, GATE-2 and GATE-3. S3 runs a script session through the real container
 * layer, the real measurement and real git inside `LocalTreeContainer`; the judge roles are the fake daemon's. The user's
 * repository is the project's own and holds the buggy `src/calc.mjs` the stub fixes. The container's disk (the double's
 * temp directory) holds the key by design and is not part of anything OMF wrote, so no sweep reads it.
 */
export async function runImplementerLine(options: ImplementerLineOptions = {}): Promise<ImplementerLineRun> {
  const { behavior = "good", seam = false, key = SENTINEL_KEY } = options;
  const local = new LocalTreeContainer();
  const secretExecs: string[][] = [];
  const jl = setupJudgeLine({
    authorIsolation: seam ? "container" : "host_command",
    preExec: (call) => {
      if (!call.name.startsWith("omf-implementer-") || sameArgv(call.argv, CONTAINER_PROBE_ARGV)) return null;
      if (call.env[CREDENTIAL_ENV.claude] !== undefined) secretExecs.push([...call.argv]);
      return local.exec(call);
    },
    implementer: ({ location, runtime, feedback, workId }) =>
      implementerStations({
        location,
        runtime,
        feedback,
        env: { [CREDENTIAL_SOURCE_ENV.claude]: key },
        session: (credential) => keyedScriptSession(runtime, credential, scriptFor(workId, behavior)),
      }),
  });
  const { fx, workId } = jl.l.f;
  const userRepo = fx.repo;
  mkdirSync(join(userRepo, "src"), { recursive: true });
  writeFileSync(join(userRepo, "src", "calc.mjs"), BUGGY);
  commitAll(userRepo, "add calc");
  const mainBefore = gitIn(userRepo, "rev-parse", "refs/heads/main").trim();
  const imageId = addImage(jl.fake.state, "omf-test/implementer:fixture", { env: ["PATH=/usr/local/bin:/usr/bin"] });
  appendFileSync(join(fx.location.dir, "config.toml"), `\n[implementer]\nimage = "${imageId}"\n`);

  const stations: Record<StationId, Station> = { ...jl.stations };
  if (seam) stations.S3 = withAuthorMeasurement(jl, stations.S3);
  let result: Finished;
  try {
    result = finished(await runLine({ location: fx.location, workId, stations, onLineEnd: jl.dispose }));
  } finally {
    await jl.dispose();
  }
  return { jl, result, events: fx.ledger.readVerified(), workId, userRepo, mainBefore, secretExecs, key };
}

const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  LC_ALL: "C",
};

function gitBytes(gitDir: string, args: readonly string[]): Buffer {
  return execFileSync("git", ["--git-dir", gitDir, ...args], {
    env: GIT_ENV,
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true })
    .map((entry) => join(root, String(entry)))
    .filter((path) => lstatSync(path).isFile());
}

/** Every git directory under `root`: a directory named `objects` next to a `HEAD`. Quarantines and scratch repositories included. */
function gitDirsUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name === "objects" && existsSync(join(entry.parentPath, "HEAD")))
    .map((entry) => entry.parentPath);
}

export interface KeySweep {
  key: string;
  /** The project's host state (ledger, items, runs, quarantines, stage directories, evidence, handoffs). */
  stateDir: string;
  /** The user's repository: its files under `.git`, and every object and ref of it. */
  userRepo: string;
  docker: FakeDocker;
  /** Anything else a test holds as text: a result, an error message, a stack. */
  texts?: Readonly<Record<string, string>>;
}

/**
 * Where the key is, as labels that never repeat it. Files are searched as bytes; every git directory is read through
 * `cat-file --batch-all-objects`, which decompresses every object including the unreachable and the removed ones, plus
 * its refs; recorded docker calls are searched as argv and as decoded stdin. An empty list is the claim.
 */
export function keyHits(sweep: KeySweep): string[] {
  const needle = Buffer.from(sweep.key);
  const has = (bytes: Buffer | string): boolean => Buffer.from(bytes).includes(needle);
  const found: string[] = [];
  for (const root of [sweep.stateDir, join(sweep.userRepo, ".git")]) {
    for (const file of filesUnder(root)) {
      if (file.includes(sweep.key) || has(readFileSync(file))) found.push(`file ${relative(root, file)}`);
    }
  }
  for (const gitDir of [...gitDirsUnder(sweep.stateDir), join(sweep.userRepo, ".git")]) {
    if (has(gitBytes(gitDir, ["cat-file", "--batch-all-objects", "--batch"]))) found.push(`objects ${gitDir}`);
    if (has(gitBytes(gitDir, ["for-each-ref"]))) found.push(`refs ${gitDir}`);
  }
  for (const call of sweep.docker.state.calls) {
    if (has(JSON.stringify(call.argv))) found.push("docker argv");
    if (call.stdin_b64 !== null && has(Buffer.from(call.stdin_b64, "base64"))) found.push("docker stdin");
  }
  for (const [name, text] of Object.entries(sweep.texts ?? {})) if (has(text)) found.push(`text ${name}`);
  return found;
}
