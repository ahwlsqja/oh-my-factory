import type { ProcessResult } from "../../src/adapters/process-group.js";
import type { ContainerAuthorDeps } from "../../src/author/codex-session.js";
import { type DockerRunner, createDockerRuntime } from "../../src/container/docker-cli.js";
import { CONTAINER_PROBE_ARGV } from "../../src/container/measure.js";
import type { ContainerRuntime } from "../../src/container/runtime.js";
import { CONFIG_DEFAULTS, type OmfConfig } from "../../src/core/config.js";
import type { ProjectLocation } from "../../src/core/paths.js";
import { type Credential, readCredential } from "../../src/implementer/credential.js";
import { buildSealPrompt } from "../../src/seal/prompt.js";
import type { AuthorRequest } from "../../src/seal/session.js";
import { FIXTURE_RUN_ID, FIXTURE_WORK_ID } from "./container-fixture.js";
import { FakeDocker, verbOf } from "./fake-docker.js";
import { type FakeExecCall, type FakeHooks, addImage } from "./fake-docker-core.mjs";
import { CLEAN_PROBE } from "./measure-fixture.js";
import { SESSION_INPUTS } from "./seal-fixture.js";
import { type TarItem, readTar } from "./tar-read.js";
import { makeTempDir } from "./tmp.js";

/** Invented digest and key; nothing here names a real image or a real credential. */
export const AUTHOR_BASE = `example.test/omf/author-base@sha256:${"d".repeat(64)}`;
export const AUTHOR_KEY = "omf-author-test-key-0123456789";
export const AUTHOR_PASS_ID = FIXTURE_RUN_ID;
export const AUTHOR_WORK_ID = FIXTURE_WORK_ID;
export const AT = new Date("2026-10-19T09:00:00Z");

/** What the scripted author "answers": the YAML text and the JSON envelope the answer file holds. */
export const YAML_TEXT = "kind: behavior\n";
export const GOOD_ANSWER = `${JSON.stringify({ scenarios_yaml: YAML_TEXT })}\n`;

export interface AuthorScript {
  /** The text of `/out/answer.json`; `null` models a Codex that wrote no file. Default `GOOD_ANSWER`. */
  answer?: string | null;
  codexStatus?: number;
  /** Replaces the whole result of the codex exec (a timeout, a spawn error, an output limit). */
  codexResult?: ProcessResult;
  /** What the in-container probe prints. Default: a clean container. */
  probe?: string;
  /** The `ENV` of the author image, as `NAME=value`. */
  imageEnv?: string[];
  /** Edits the daemon's inspect document: the way a test models a deviation from the golden argv. */
  tamper?: FakeHooks["inspect"];
}

export interface AuthorDouble {
  fake: FakeDocker;
  runtime: ContainerRuntime;
  /** Every `docker exec` the daemon double answered, with the environment the client resolved. */
  execs: FakeExecCall[];
  /** The archives extracted into the container, by destination, already unpacked. */
  extracted: Array<{ dest: string; items: TarItem[] }>;
  /** The timeout of every docker call, in order. */
  runs: Array<{ argv: string[]; timeoutMs: number; maxOutputBytes: number }>;
}

const sameArgv = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((part, index) => part === b[index]);
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });

export function authorDouble(script: AuthorScript = {}): AuthorDouble {
  const execs: FakeExecCall[] = [];
  const extracted: AuthorDouble["extracted"] = [];
  const runs: AuthorDouble["runs"] = [];
  const answer = script.answer === undefined ? GOOD_ANSWER : script.answer;
  const fake = new FakeDocker({
    ...(script.tamper === undefined ? {} : { tamper: script.tamper }),
    exec: (call) => {
      execs.push(call);
      if (sameArgv(call.argv, CONTAINER_PROBE_ARGV)) return ok(script.probe ?? CLEAN_PROBE);
      const [command] = call.argv;
      if (command === "tar") {
        const dest = call.argv[call.argv.indexOf("-C") + 1] ?? "";
        extracted.push({ dest, items: readTar(call.stdin ?? Buffer.alloc(0)) });
        return ok();
      }
      if (command === "codex") {
        return { status: script.codexStatus ?? 0, stdout: "PRIVATE-STDOUT", stderr: "PRIVATE-STDERR" };
      }
      if (command === "cat") return answer === null ? { status: 1, stdout: "", stderr: "no such file" } : ok(answer);
      return { status: 127, stdout: "", stderr: "not scripted" };
    },
  });
  addImage(fake.state, AUTHOR_BASE, { env: script.imageEnv ?? ["PATH=/usr/local/bin:/usr/bin"] });
  if (script.codexResult !== undefined) {
    const result = script.codexResult;
    fake.intercept = (argv) => (verbOf(argv) === "exec" && argv.includes("codex") ? result : null);
  }
  const run: DockerRunner = (argv, options) => {
    runs.push({ argv: [...argv], timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes });
    return fake.run(argv, options);
  };
  const runtime = createDockerRuntime({
    context: "fake",
    run,
    runSync: fake.runSync,
    env: { PATH: "/usr/bin", HOME: "/home/x" },
  });
  return { fake, runtime, execs, extracted, runs };
}

/** The defaults plus the author image; `model` null leaves `roles.author.model` unset. */
export function authorConfig(model: string | null = "gpt-5-codex"): OmfConfig {
  return {
    ...CONFIG_DEFAULTS,
    roles: { ...CONFIG_DEFAULTS.roles, author: model === null ? { vendor: "codex" } : { vendor: "codex", model } },
    author: { ...CONFIG_DEFAULTS.author, image: AUTHOR_BASE },
  };
}

export function authorCredential(value: string = AUTHOR_KEY): Credential {
  const credential = readCredential("codex", { OMF_AUTHOR_API_KEY: value });
  if (credential === null) throw new Error("the test key was rejected by readCredential");
  return credential;
}

/** Invented paths under fresh temp directories: nothing touches a real home. */
export const AUTHOR_LOCATION: ProjectLocation = {
  repo: makeTempDir("omf-author-repo-"),
  id: "p-author-test",
  dir: `${makeTempDir("omf-author-home-")}/projects/p-author-test`,
};

export function authorDeps(double: AuthorDouble, extra: Partial<ContainerAuthorDeps> = {}): ContainerAuthorDeps {
  return {
    runtime: double.runtime,
    location: AUTHOR_LOCATION,
    config: authorConfig(),
    credential: authorCredential(),
    passId: AUTHOR_PASS_ID,
    round: 1,
    workId: AUTHOR_WORK_ID,
    now: () => AT,
    ...extra,
  };
}

/** A request whose prompt is exactly the one built from its inputs. */
export function authorRequest(timeoutMs = 60_000): AuthorRequest {
  return { prompt: buildSealPrompt(SESSION_INPUTS), inputs: SESSION_INPUTS, timeoutMs };
}
