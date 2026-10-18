import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContainerAuthorSession } from "../../src/author/codex-session.js";
import type { ContainerRuntime } from "../../src/container/runtime.js";
import { sha256Hex } from "../../src/core/canonical-json.js";
import { recordStageMeasurement } from "../../src/isolation/record.js";
import type { IsolationLevel, StageMeasurement } from "../../src/isolation/types.js";
import { foldSeals } from "../../src/scenario/events.js";
import type { AuthorFailureCode } from "../../src/scenario/types.js";
import { runSealStage } from "../../src/seal/seal.js";
import type { AuthorOutcome, AuthorRequest } from "../../src/seal/session.js";
import { measurement } from "./gate3-parts.js";
import { type LineFixture, sealDeps } from "./line-fixture.js";

/** A printable-ASCII key nobody else uses, so a test can search every surface for it. */
export const AUTHOR_KEY = "sk-author-sentinel-0123456789abcdef";
export const AUTHOR_IMAGE = `example.test/omf/author@sha256:${"d".repeat(64)}`;
export const AUTHOR_CONTEXT = "colima-omf-m3f";
/** A run-shaped id for measurements a test binds by hand. */
export const AUTHOR_PASS = "r-20261014T000000Z-0001";

export interface AuthorConfigOptions {
  /** `[judge] docker_context`; null leaves it unset. Default `AUTHOR_CONTEXT`. */
  context?: string | null;
  /** `[author] image`; null leaves it unset. Default `AUTHOR_IMAGE`. */
  image?: string | null;
  /** "same_vendor" gives the author the implementer's vendor (claude); "swapped" makes the author claude and the implementer codex. */
  roles?: "default" | "same_vendor" | "swapped";
}

/** Appends the `[judge]` and `[author]` tables the station reads to the config `omf init` wrote. */
export function writeAuthorConfig(l: LineFixture, options: AuthorConfigOptions = {}): void {
  const { context = AUTHOR_CONTEXT, image = AUTHOR_IMAGE, roles = "default" } = options;
  let base = l.f.fx.baseConfig;
  if (roles !== "default") base = base.replace('author = { vendor = "codex" }', 'author = { vendor = "claude" }');
  if (roles === "swapped")
    base = base.replace('implementer = { vendor = "claude" }', 'implementer = { vendor = "codex" }');
  writeFileSync(
    join(l.f.fx.location.dir, "config.toml"),
    [
      base,
      ...(context === null ? [] : ["[judge]", `docker_context = "${context}"`, ""]),
      "[author]",
      ...(image === null ? [] : [`image = "${image}"`]),
      "",
    ].join("\n"),
  );
}

/** The runtime with some members replaced; every other member keeps its own state (`this` stays the base). */
export function withOverrides(base: ContainerRuntime, over: Partial<ContainerRuntime>): ContainerRuntime {
  return new Proxy(base, {
    get(target, prop) {
      if (prop in over) return (over as Record<PropertyKey, unknown>)[prop];
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export interface ScriptedAuthorOptions {
  /** What the double hands over after a run. Default: an L2 author container. null: no measurement reaches the host. */
  measurement?: StageMeasurement | null;
  /** The run fails with this code instead of printing the YAML. */
  failure?: AuthorFailureCode;
  /** Violation codes carried in the facts of a failed run. */
  violations?: string[];
}

export interface ScriptedAuthor extends ContainerAuthorSession {
  /** Every request the session was given, in order. */
  requests: AuthorRequest[];
}

/**
 * A `ContainerAuthorSession` that answers with the stub author's YAML but stamps itself as a container Codex author,
 * the way Task 4's real session does. It holds a scripted measurement and the facts of the run, each once.
 */
export function scriptedAuthor(
  l: LineFixture,
  yamlPath: string,
  passId: string,
  options: ScriptedAuthorOptions = {},
): ScriptedAuthor {
  const inner = sealDeps(l, yamlPath).session;
  const requests: AuthorRequest[] = [];
  let measurementTaken = false;
  return {
    id: "scripted-container-author",
    vendor: "codex",
    model: "codex-default",
    isolation: "container",
    requests,
    async run(request): Promise<AuthorOutcome> {
      requests.push(request);
      if (options.failure !== undefined) return { ok: false, code: options.failure, durationMs: 1 };
      return inner.run(request);
    },
    takeMeasurement() {
      if (measurementTaken || options.failure !== undefined) return null;
      measurementTaken = true;
      return options.measurement === undefined ? measurement("author", "L2", 1) : options.measurement;
    },
    takeFacts() {
      const first = requests[0];
      if (first === undefined) return null;
      const failed = options.failure !== undefined;
      return {
        pass_id: passId,
        round: 1,
        vendor: "codex",
        model: "codex-default",
        outcome: options.failure ?? "completed",
        duration_ms: 1,
        image_id: `sha256:${"e".repeat(64)}`,
        input_sha256: sha256Hex(first.prompt),
        violation_codes: options.violations ?? [],
        answer_sha256: failed ? null : sha256Hex("answer"),
        answer_bytes: failed ? 0 : 6,
        credential_hits: 0,
        injected_secret_names: ["CODEX_API_KEY"],
      };
    },
  };
}

/** Runs the seal stage with a container-stamped author and no recording hook: the seal is stored, nothing is measured yet. */
export async function sealStamped(
  l: LineFixture,
  yamlPath: string,
  options: ScriptedAuthorOptions = {},
): Promise<{ seal_id: string; set_sha256: string }> {
  const stage = await runSealStage({
    ...sealDeps(l, yamlPath),
    session: scriptedAuthor(l, yamlPath, AUTHOR_PASS, options),
  });
  if (stage.status !== "stored") throw new Error(`expected a stored seal, got ${stage.status}`);
  return { seal_id: stage.seal_id, set_sha256: stage.set_sha256 };
}

/** Appends an author `isolation.measured` event bound to the latest seal, the way a recorded measurement would be. */
export function bindMeasurement(l: LineFixture, level: IsolationLevel): void {
  const seal = foldSeals(l.f.fx.ledger.readVerified(), l.f.scope).latest;
  if (seal === null) throw new Error("no seal to bind a measurement to");
  recordStageMeasurement(
    l.f.fx.ledger,
    { ...l.f.scope, run_id: AUTHOR_PASS },
    l.f.item.dir,
    measurement("author", level, 1),
    { seal_seq: seal.seq, set_sha256: seal.set_sha256 },
  );
}
