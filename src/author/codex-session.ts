import type { ProcessResult } from "../adapters/process-group.js";
import { containerSpecFor, goldenFor } from "../container/golden.js";
import { ImageRefError, pinnedImage } from "../container/image-ref.js";
import { MeasureError, NotGoldenError, createMeasured } from "../container/measure.js";
import {
  type ContainerHandle,
  type ContainerRuntime,
  type ExecSpec,
  type ImageInfo,
  RuntimeError,
} from "../container/runtime.js";
import { ContainerSpecError, isImageId } from "../container/spec.js";
import { type TarEntry, tarOfEntries } from "../container/tar-dir.js";
import { sha256Hex } from "../core/canonical-json.js";
import type { OmfConfig } from "../core/config.js";
import type { ProjectLocation } from "../core/paths.js";
import type { Credential } from "../implementer/credential.js";
import { failureCodeOf, outputOf } from "../implementer/session.js";
import type { StageMeasurement } from "../isolation/types.js";
import { judgeForbiddenPaths } from "../judge/forbidden.js";
import { type AuthorFailureCode, MAX_AUTHOR_OUTPUT_BYTES } from "../scenario/types.js";
import { SealInputError, type SealInputs, buildSealPrompt } from "../seal/prompt.js";
import type { AgentSession, AuthorOutcome, AuthorRequest } from "../seal/session.js";
import {
  ANSWER_FILE,
  ANSWER_SCHEMA_TEXT,
  AUTHOR_IN,
  CodexArgvError,
  OUTPUT_SUFFIX,
  codexArgv,
  refuseInteractive,
} from "./codex-argv.js";
import type { AuthorSessionFacts } from "./events.js";

/** Stamped into the ledger and the scenario files when `roles.author.model` is unset. */
export const DEFAULT_MODEL_LABEL = "codex-default";

const STEP_MS = 30_000;
const SMALL_OUTPUT_BYTES = 4096;

export interface ContainerAuthorSession extends AgentSession {
  readonly vendor: "codex";
  readonly isolation: "container";
  /** The full judgment of the golden container this session last used, once; null if nothing ran or it was not golden. */
  takeMeasurement(): StageMeasurement | null;
  /** The facts for `author.session_completed`, once per run; null when the run never reached an image (no container). */
  takeFacts(): AuthorSessionFacts | null;
}

export interface ContainerAuthorDeps {
  /** Already wrapped with `trackRuntime` by the caller, so a killed pass still removes the container. */
  runtime: ContainerRuntime;
  location: ProjectLocation;
  config: OmfConfig;
  credential: Credential;
  /** The pass's run-shaped id, used as the container label `run_id`. */
  passId: string;
  /** A label only, >= 1. */
  round: number;
  workId: string;
  now: () => Date;
}

let authorSerial = 0;

/** Exactly one non-empty string field `scenarios_yaml`; anything else is no answer. */
export function parseAnswer(text: string): { ok: true; yaml: string } | { ok: false } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false };
  const yaml = (parsed as Record<string, unknown>).scenarios_yaml;
  if (Object.keys(parsed).length !== 1 || typeof yaml !== "string" || yaml.trim() === "") return { ok: false };
  return { ok: true, yaml };
}

/** Occurrences of the key as text and in its JSON-escaped spelling (the answer is JSON, so a quote in the key is escaped). */
function keyHits(text: string, credential: Credential): number {
  const plain = credential.reveal();
  const escaped = JSON.stringify(plain).slice(1, -1);
  const hits = text.split(plain).length - 1;
  return escaped === plain ? hits : hits + (text.split(escaped).length - 1);
}

const fileEntry = (path: string, text: string): TarEntry => ({
  path,
  kind: "file",
  data: Buffer.from(text, "utf8"),
  linkTarget: "",
  executable: false,
});

/** `intent.md`, `spec.md` and `contract.json`: the whole content of `/in`. Nothing else of the item crosses over. */
function inputsTar(inputs: SealInputs): Buffer {
  return tarOfEntries([
    fileEntry("intent.md", inputs.intent),
    fileEntry("spec.md", inputs.spec),
    fileEntry("contract.json", `${JSON.stringify(inputs.contract, null, 2)}\n`),
  ]);
}

/** The schema Codex answers in, and an empty `CODEX_HOME` directory, so no shell is needed to make it. */
function agentTar(): Buffer {
  return tarOfEntries([
    { path: "codex", kind: "dir", data: Buffer.alloc(0), linkTarget: "", executable: false },
    fileEntry("answer.schema.json", ANSWER_SCHEMA_TEXT),
  ]);
}

/** True when the request is not what `runSealStage` builds: a prompt that is exactly `buildSealPrompt(inputs)` and a usable limit. */
function requestProblem(request: AuthorRequest, timeoutMs: number): boolean {
  if (typeof request.inputs !== "object" || request.inputs === null) return true;
  if (request.prompt === "" || !Number.isFinite(timeoutMs) || timeoutMs < 1) return true;
  try {
    return buildSealPrompt(request.inputs) !== request.prompt;
  } catch (error) {
    if (error instanceof SealInputError) return true;
    throw error;
  }
}

/**
 * Codex inside the author container (spec §5.3, §7). In order: create, inspect, pre-gate, start and probe through
 * `createMeasured` with a `defer` hook, so the measurement is held and not recorded (there is no seal yet to bind it
 * to); the inputs go in by `tar -x` on stdin; only then does one exec carry the key, as a `SecretHandle`, with the
 * prompt plus the answer-envelope suffix on stdin; then `/out/answer.json` is read back and unwrapped. What Codex printed
 * is counted for the key and dropped: only a failure code or the YAML string leaves this function. The container is
 * removed on every path.
 */
export function createContainerAuthor(deps: ContainerAuthorDeps): ContainerAuthorSession {
  const { runtime, config, credential } = deps;
  const model = config.roles.author.model ?? null;
  const stampedModel = model ?? DEFAULT_MODEL_LABEL;
  let measurement: StageMeasurement | null = null;
  let facts: AuthorSessionFacts | null = null;

  return {
    id: `codex:${model ?? "default"}`,
    vendor: "codex",
    model: stampedModel,
    isolation: "container",

    takeMeasurement(): StageMeasurement | null {
      const held = measurement;
      measurement = null;
      return held;
    },

    takeFacts(): AuthorSessionFacts | null {
      const held = facts;
      facts = null;
      return held;
    },

    async run(request: AuthorRequest): Promise<AuthorOutcome> {
      const started = performance.now();
      const elapsed = (): number => Math.round(performance.now() - started);
      measurement = null;
      facts = null;
      const seen = {
        imageId: null as string | null,
        stdinSha: "",
        violations: [] as string[],
        answerSha: null as string | null,
        answerBytes: 0,
        hits: 0,
      };
      const finalize = (outcome: "completed" | AuthorFailureCode): void => {
        if (seen.imageId === null) return;
        facts = {
          pass_id: deps.passId,
          round: deps.round,
          vendor: "codex",
          model: stampedModel,
          outcome,
          duration_ms: elapsed(),
          image_id: seen.imageId,
          input_sha256: seen.stdinSha,
          violation_codes: seen.violations,
          answer_sha256: seen.answerSha,
          answer_bytes: seen.answerBytes,
          credential_hits: seen.hits,
          injected_secret_names: ["CODEX_API_KEY"],
        };
      };
      const fail = (code: AuthorFailureCode): AuthorOutcome => {
        finalize(code);
        return { ok: false, code, durationMs: elapsed() };
      };

      const timeoutMs = Math.min(request.timeoutMs, config.author.timeout_ms);
      const image = config.author.image;
      if (credential.name !== "CODEX_API_KEY" || image === null || requestProblem(request, timeoutMs)) {
        return fail("misconfigured");
      }
      let argv: string[];
      try {
        argv = codexArgv({ model });
      } catch (error) {
        if (error instanceof CodexArgvError) return fail("misconfigured");
        throw error;
      }
      if (refuseInteractive(argv) !== null) return fail("misconfigured");
      const stdin = `${request.prompt}${OUTPUT_SUFFIX}`;

      let handle: ContainerHandle;
      try {
        const info: ImageInfo = isImageId(image)
          ? await runtime.imageInfo(image)
          : await runtime.ensureImage(pinnedImage(image));
        seen.imageId = info.id;
        seen.stdinSha = sha256Hex(stdin);
        authorSerial += 1;
        const spec = containerSpecFor({
          role: "author",
          image: info.id,
          labels: { work_id: deps.workId, run_id: deps.passId, round: deps.round },
          serial: authorSerial,
          limits: { kind: "author", author: config.author },
        });
        const golden = goldenFor({ role: "author", image: info, forbidden: judgeForbiddenPaths(deps.location) });
        const defer = (judged: StageMeasurement): void => {
          measurement = judged;
        };
        handle = (await createMeasured({ runtime, now: deps.now, defer }, spec, golden)).handle;
      } catch (error) {
        if (error instanceof NotGoldenError) {
          seen.violations = [...error.violations];
          return fail("not_golden");
        }
        const known =
          error instanceof MeasureError ||
          error instanceof RuntimeError ||
          error instanceof ContainerSpecError ||
          error instanceof ImageRefError;
        if (known) return fail("container_failed");
        throw error;
      }

      // A runtime that throws (daemon gone, bad name) is an error result: every non-exit maps to a closed code.
      const exec = async (spec: ExecSpec): Promise<ProcessResult> => {
        try {
          return await runtime.exec(handle, spec);
        } catch (error) {
          if (error instanceof RuntimeError || error instanceof ContainerSpecError) {
            return { kind: "error", code: null, message: "runtime_error" };
          }
          throw error;
        }
      };
      const put = async (dest: string, archive: Buffer): Promise<boolean> => {
        const result = await exec({
          argv: ["tar", "-x", "-f", "-", "-C", dest],
          stdin: archive,
          timeoutMs: STEP_MS,
          maxOutputBytes: SMALL_OUTPUT_BYTES,
        });
        return failureCodeOf(result) === null;
      };

      try {
        if (!(await put(AUTHOR_IN, inputsTar(request.inputs))) || !(await put("/agent", agentTar()))) {
          return fail("container_failed");
        }

        const ran = await exec({ argv, stdin, timeoutMs, maxOutputBytes: MAX_AUTHOR_OUTPUT_BYTES, secret: credential });
        const printed = outputOf(ran);
        seen.hits += keyHits(printed.stdout, credential) + keyHits(printed.stderr, credential);
        const ranCode = failureCodeOf(ran);
        if (ranCode !== null) return fail(ranCode);

        const read = await exec({
          argv: ["cat", ANSWER_FILE],
          timeoutMs: STEP_MS,
          maxOutputBytes: MAX_AUTHOR_OUTPUT_BYTES,
        });
        const readCode = failureCodeOf(read);
        // `cat` of a file Codex never wrote exits non-zero: that is no answer, not a failed process.
        if (readCode === "nonzero_exit") return fail("no_output");
        if (readCode !== null) return fail(readCode);
        const text = outputOf(read).stdout;
        const leaked = keyHits(text, credential);
        if (leaked > 0) {
          seen.hits += leaked;
          return fail("credential_in_output");
        }
        seen.answerSha = sha256Hex(text);
        seen.answerBytes = Buffer.byteLength(text);
        const answer = parseAnswer(text);
        if (!answer.ok) return fail("no_output");
        finalize("completed");
        return { ok: true, output: answer.yaml, durationMs: elapsed() };
      } finally {
        // Idempotent. A failed removal leaves an orphan with the omf.owner label for the author-role sweep.
        await runtime.remove(handle).catch(() => undefined);
      }
    },
  };
}
