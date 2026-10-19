import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContainerAuthorSession } from "../../src/author/codex-session.js";
import { containerSpecFor, goldenFor } from "../../src/container/golden.js";
import { pinnedImage } from "../../src/container/image-ref.js";
import { createMeasured } from "../../src/container/measure.js";
import type { ContainerHandle, ContainerRuntime, ImageInfo } from "../../src/container/runtime.js";
import { CONFIG_DEFAULTS } from "../../src/core/config.js";
import type { LedgerEvent } from "../../src/core/ledger.js";
import { type Credential, containsCredential, readCredential } from "../../src/implementer/credential.js";
import type { AuthorOutcome, AuthorRequest } from "../../src/seal/session.js";
import { listFiles } from "../helpers/ops-fixture.js";
import { GatedRefusal } from "./helpers.js";
import { GATED_LABELS } from "./lifecycle-support.js";

// Shared by the three author suites. Like implementer-support.ts, nothing here prints or reveals a key: the suites that hold a
// real key assert through assertTrue and assertFalse, whose messages are fixed strings.

/** The made-up key of the docker-only suite. It exists to show where a secret is visible; no provider has ever seen it. */
export const SENTINEL_VALUE = "sk-codex-gated-fake-0123456789abcdef";

export function sentinelCredential(): Credential {
  const credential = readCredential("codex", { OMF_AUTHOR_API_KEY: SENTINEL_VALUE });
  if (credential === null) throw new Error("the sentinel credential must be readable");
  return credential;
}

/** The owner's author key from OMF_AUTHOR_API_KEY, which the driver passes only in model mode. A refusal never names a value. */
export function authorCredential(env: NodeJS.ProcessEnv = process.env): Credential {
  const credential = readCredential("codex", env);
  if (credential === null) throw new GatedRefusal("the author suites need OMF_AUTHOR_API_KEY in the environment");
  return credential;
}

/** The owner's author image: a digest reference or a local image id (`sha256:<64 hex>`). Never pulled by tag. */
export async function gatedAuthorImage(runtime: ContainerRuntime): Promise<ImageInfo> {
  const ref = process.env.OMF_GATED_AUTHOR_IMAGE;
  if (ref === undefined || ref === "") {
    throw new GatedRefusal("OMF_GATED_AUTHOR_IMAGE must name the author image: a digest reference or a local image id");
  }
  return /^sha256:[0-9a-f]{64}$/.test(ref) ? runtime.imageInfo(ref) : runtime.ensureImage(pinnedImage(ref));
}

/** The author container, created and measured against the golden before it is returned; removal is the caller's. */
export async function measuredAuthor(
  runtime: ContainerRuntime,
  input: { dir: string; forbidden: readonly string[] },
  image: ImageInfo,
) {
  const spec = containerSpecFor({
    role: "author",
    image: image.id,
    labels: GATED_LABELS,
    serial: 1,
    limits: { kind: "author", author: { ...CONFIG_DEFAULTS.author, image: image.id } },
  });
  const golden = goldenFor({ role: "author", image, forbidden: [...input.forbidden] });
  // Deferred mode: an author-stage measurement can be recorded only bound to a seal (src/gate/events.ts), and this suite seals nothing.
  const deps = { runtime, now: () => new Date(), defer: () => undefined };
  return createMeasured(deps, spec, golden);
}

/** A runtime that hands every `docker inspect` document it returns to `docs`, so a suite can read what the daemon said. */
export function spyInspect(inner: ContainerRuntime, docs: unknown[]): ContainerRuntime {
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === "inspect") {
        return async (handle: ContainerHandle) => {
          const doc = await target.inspect(handle);
          docs.push(doc);
          return doc;
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The bind mounts of an inspect document (the parsed array or its first element); none is the expected answer. */
export function bindsOf(doc: unknown): string[] {
  const first = (Array.isArray(doc) ? doc[0] : doc) as { HostConfig?: { Binds?: string[] | null } } | null | undefined;
  return first?.HostConfig?.Binds ?? [];
}

/** The real session with its answer kept: every successful output is pushed to `answers`; nothing else changes. */
export function recordingSession(inner: ContainerAuthorSession, answers: string[]): ContainerAuthorSession {
  return {
    id: inner.id,
    vendor: inner.vendor,
    model: inner.model,
    isolation: inner.isolation,
    takeMeasurement: () => inner.takeMeasurement(),
    takeFacts: () => inner.takeFacts(),
    async run(request: AuthorRequest): Promise<AuthorOutcome> {
      const outcome = await inner.run(request);
      if (outcome.ok) answers.push(outcome.output);
      return outcome;
    },
  };
}

/** Paths under `root` whose bytes hold the key. A symlink is skipped, never followed. */
export function filesHoldingCredential(root: string, credential: Credential): string[] {
  return listFiles(root).filter((path) => {
    const full = join(root, path);
    return !lstatSync(full).isSymbolicLink() && containsCredential(readFileSync(full), credential);
  });
}

/** True when the ledger holds an author measurement at L2 bound to a seal. */
export function authorMeasuredL2(events: readonly LedgerEvent[]): boolean {
  return events.some(
    (event) =>
      event.type === "isolation.measured" &&
      event.payload.stage === "author" &&
      event.payload.level === "L2" &&
      event.payload.author_scope !== null,
  );
}
