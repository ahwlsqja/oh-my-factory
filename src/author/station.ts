import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { findWorkItem } from "../adapters/state-markdown.js";
import type { RecordSink, RunScope } from "../audit/work-audit.js";
import { type ContainerRuntime, RuntimeError } from "../container/runtime.js";
import { assertName } from "../container/spec.js";
import { type OmfConfig, readConfig } from "../core/config.js";
import { Ledger } from "../core/ledger.js";
import { acquireLock, LockHeldError, releaseLock } from "../core/lock.js";
import type { ProjectLocation } from "../core/paths.js";
import { authorVendorRefusal, sameVendorRefusal } from "../core/roles.js";
import { evaluateGate1, intentQuestionIds } from "../decision/gate1.js";
import { loadLeakContext } from "../decision/leak-lint.js";
import { foldDecisions } from "../decision/state.js";
import type { DecisionScope } from "../decision/types.js";
import { exposureCountFor } from "../feedback/events.js";
import { type Credential, readCredential } from "../implementer/credential.js";
import { recordStageMeasurement } from "../isolation/record.js";
import type { StageMeasurement } from "../isolation/types.js";
import { trackRuntime } from "../judge/state.js";
import { authorPrecedesStart, foldSeals, type SealFailureCode, sealFeedbackFromEvents } from "../scenario/events.js";
import { createHostFixtureRunner } from "../scenario/fixtures.js";
import { randomIds } from "../scenario/intake.js";
import { sealLockFile } from "../seal/seal.js";
import { runS2ThenGate2 } from "../seal/station.js";
import { assertLineSafe, guardRefusal, locationEnv } from "../vault/line-guard.js";
import { openVault } from "../vault/vault.js";
import type { Station } from "../work/sequencer.js";
import { newRunId } from "../work/w-events.js";
import { type ContainerAuthorSession, createContainerAuthor } from "./codex-session.js";
import { authorSessionCompletedEvent } from "./events.js";
import { standingSeal } from "./standing.js";

/** Why a seal pass did not start. Nothing is written and no container is created for any of them. */
export type AuthorRefusalCode =
  | "docker_context_unset"
  | "author_image_unset"
  | "author_key_missing"
  | "same_vendor"
  | "author_vendor_unsupported"
  | "docker_unreachable"
  | "endpoint_not_local";

export type SealPassResult =
  // Only for a standing seal whose author stage is measured L2.
  | { status: "already_sealed"; seal_id: string; author_measured: true }
  | { status: "sealed"; seal_id: string; round: number; author_measured: true; gate2: "pass" }
  // M3c convention: "stored", never "sealed", when the author is unmeasured.
  | { status: "stored"; seal_id: string; round: number; author_measured: false; gate2: "pass" }
  // An author-quality failure, or GATE-2 sending the item back to S2: the person reruns.
  | { status: "retry"; code: SealFailureCode | "gate2_back_to_s2" }
  // GATE-1 (J2), the scenarios (J3) or the environment (J7).
  | { status: "blocked"; route: "J2" | "J3" | "J7"; code: string }
  | { status: "refused"; code: AuthorRefusalCode };

export interface SealItemDeps {
  location: ProjectLocation;
  workId: string;
  runtime: ContainerRuntime;
  /** Where the key is read from (`OMF_AUTHOR_API_KEY`). The state root is taken from the location, never from here. */
  env: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Tests only: replaces the container session. The real one is built from the config and the key. */
  session?: (credential: Credential, passId: string) => ContainerAuthorSession;
}

type Cleared = { refused: null; config: OmfConfig; credential: Credential };

/**
 * Everything that can stop a seal pass before it writes anything, in this order: the roles (so a same-vendor pairing is
 * refused before a key is read), the context, the image, the key, then the daemon and its endpoint. An unreadable or
 * invalid config throws `ConfigError`; the CLI prints its message.
 */
export async function authorRefusal(input: {
  location: ProjectLocation;
  runtime: ContainerRuntime;
  env: NodeJS.ProcessEnv;
}): Promise<Cleared | { refused: AuthorRefusalCode }> {
  const config = readConfig(input.location.dir);
  if (sameVendorRefusal(config) !== null) return { refused: "same_vendor" };
  if (authorVendorRefusal(config) !== null) return { refused: "author_vendor_unsupported" };
  if (config.judge.docker_context === null || input.runtime.context === null)
    return { refused: "docker_context_unset" };
  if (config.author.image === null) return { refused: "author_image_unset" };
  const credential = readCredential("codex", input.env);
  if (credential === null) return { refused: "author_key_missing" };
  try {
    if (!(await input.runtime.info()).ok) return { refused: "docker_unreachable" };
    if (!(await input.runtime.endpoint()).local) return { refused: "endpoint_not_local" };
  } catch (error) {
    const local = error instanceof RuntimeError && error.code === "endpoint_not_local";
    return { refused: local ? "endpoint_not_local" : "docker_unreachable" };
  }
  return { refused: null, config, credential };
}

/**
 * Removes author containers that earlier passes of THIS item left behind (a SIGKILL during `codex exec` runs no handler).
 * A pass marker `<item>/runs/<pass id>` exists before its container does, so the directories under `runs/` name every
 * pass this item ever started; a container of the author role whose run id is one of them (and not the current pass) is
 * an orphan. SUT, harness, work-copy and implementer containers are never touched here: they belong to `omf run`.
 */
export async function sweepAuthorOrphans(input: {
  runtime: Pick<ContainerRuntime, "listOwned" | "remove">;
  itemDir: string;
  currentPassId: string;
}): Promise<number> {
  const runsDir = join(input.itemDir, "runs");
  const earlier = new Set(existsSync(runsDir) ? readdirSync(runsDir) : []);
  earlier.delete(input.currentPassId);
  let removed = 0;
  for (const resource of await input.runtime.listOwned({ run_id: null })) {
    if (resource.kind !== "container" || !resource.name.startsWith("omf-author-")) continue;
    if (!earlier.has(resource.run_id)) continue;
    try {
      assertName(resource.name);
    } catch {
      continue;
    }
    await input.runtime.remove({ name: resource.name, id: resource.name, role: "author" });
    removed += 1;
  }
  return removed;
}

/** Thrown inside the ledger lock when the seal a measurement was made for is not the item's latest any more. */
class StaleSeal extends Error {}

/**
 * Called by `afterSealCompleted` while `seal.lock` is held (spec §5.3, §7). The measurement belongs to the seal this pass
 * stored: the seq and set hash are read from the ledger, and inside `ledger.appendWith` (the ledger lock) the item's latest
 * seal is checked again, so a seal that landed in between is never attested by this container. Returns false, writing
 * nothing, when the seal is unknown or no longer the latest. `loadRunIsolation` applies the same binding when it reads.
 */
export function recordAuthorMeasurement(input: {
  ledger: Pick<Ledger, "readVerified" | "appendWith">;
  itemDir: string;
  scope: RunScope;
  measurement: StageMeasurement;
  seal: { seal_id: string; set_sha256: string };
}): boolean {
  const { ledger, scope, seal } = input;
  const item: DecisionScope = { goal_id: scope.goal_id, work_id: scope.work_id };
  const known = foldSeals(ledger.readVerified(), item).records.find(
    (record) => record.seal_id === seal.seal_id && record.set_sha256 === seal.set_sha256,
  );
  if (known === undefined) return false;
  const sink: RecordSink = {
    appendWith: (build) =>
      ledger.appendWith((events) => {
        if (foldSeals(events, item).latest?.seq !== known.seq) throw new StaleSeal();
        return build(events);
      }),
  };
  try {
    recordStageMeasurement(sink, scope, input.itemDir, input.measurement, {
      seal_seq: known.seq,
      set_sha256: known.set_sha256,
    });
    return true;
  } catch (error) {
    if (error instanceof StaleSeal) return false;
    throw error;
  }
}

/**
 * One `omf seal` pass (spec §5.3, M3-D16). In order:
 * 1. the line guard (sealed material in the repository, a symlink in the state tree) is a J7 stop;
 * 2. a standing seal whose author stage is measured L2 answers `already_sealed` here: no key, no daemon, no model call.
 *    A standing seal with an unmeasured author falls through and is sealed again;
 * 3. the refusals of `authorRefusal`: nothing is written;
 * 4. under `seal.lock`: the pass marker `runs/<pass id>/` is created BEFORE any `docker create`, then author containers of
 *    earlier passes are swept. A lock held by another pass is a J7 stop `seal_in_progress`;
 * 5. S2 and GATE-2 over the container author. The session's measurement is recorded by `afterSealCompleted`, inside the
 *    seal lock and bound to this pass's seal. A crash between `seal.completed` and the record leaves the seal unmeasured;
 * 6. `author.session_completed` is appended once per container run, whatever the outcome; the tracked runtime is closed.
 * The result reads the ledger again: `sealed` only when `standingSeal` says the author is measured.
 */
export async function sealItem(deps: SealItemDeps): Promise<SealPassResult> {
  const { location, workId, runtime } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const item = findWorkItem(location.dir, workId);
  if (item === null) throw new Error(`work item ${workId} is unknown`);
  const scope: DecisionScope = { goal_id: item.front.goal_id, work_id: item.front.work_id };
  const stateEnv = locationEnv(location);
  try {
    assertLineSafe(location, stateEnv);
  } catch (error) {
    const code = guardRefusal(error);
    if (code === null) throw error;
    return { status: "blocked", route: "J7", code };
  }
  const ledger = new Ledger(location.dir, now);
  const vault = openVault(location, stateEnv);
  const before = ledger.readVerified();
  const standing = standingSeal(before, scope, item.dir, vault);
  if (standing?.author_measured === true) {
    return { status: "already_sealed", seal_id: standing.seal.seal_id, author_measured: true };
  }

  const cleared = await authorRefusal({ location, runtime, env: deps.env });
  if (cleared.refused !== null) return { status: "refused", code: cleared.refused };

  const passId = newRunId(now());
  const lock = sealLockFile(item.dir);
  try {
    acquireLock(lock);
  } catch (error) {
    if (error instanceof LockHeldError) return { status: "blocked", route: "J7", code: "seal_in_progress" };
    throw error;
  }
  try {
    mkdirSync(join(item.dir, "runs", passId), { recursive: true, mode: 0o700 });
    await sweepAuthorOrphans({ runtime, itemDir: item.dir, currentPassId: passId });
  } catch {
    return { status: "blocked", route: "J7", code: "author_pass_setup_failed" };
  } finally {
    releaseLock(lock);
  }

  const tracked = trackRuntime(runtime);
  const session =
    deps.session?.(cleared.credential, passId) ??
    createContainerAuthor({
      runtime: tracked,
      location,
      config: cleared.config,
      credential: cleared.credential,
      passId,
      round: foldSeals(before, scope).completed + 1,
      workId,
      now,
    });
  const feedback = sealFeedbackFromEvents(before, scope);
  const runScope: RunScope = { ...scope, run_id: passId };
  const pass = await runS2ThenGate2({
    location,
    item,
    session,
    ledger,
    vault,
    now,
    ids: randomIds(),
    timeoutMs: cleared.config.author.timeout_ms,
    env: stateEnv,
    runner: createHostFixtureRunner(),
    exposureCount: exposureCountFor(before, scope.goal_id, scope.work_id),
    ...(feedback === null ? {} : { feedback }),
    afterSealCompleted: (sealed) => {
      const measurement = session.takeMeasurement();
      if (measurement !== null)
        recordAuthorMeasurement({ ledger, itemDir: item.dir, scope: runScope, measurement, seal: sealed });
    },
  }).finally(() => {
    tracked.close();
    const facts = session.takeFacts();
    if (facts !== null) ledger.append(authorSessionCompletedEvent(scope, facts));
  });

  switch (pass.status) {
    case "stop":
      return { status: "blocked", route: pass.route, code: pass.code };
    case "retry_s2":
      return { status: "retry", code: pass.code };
    case "back_to_S2":
      return { status: "retry", code: "gate2_back_to_s2" };
    case "pass": {
      const after = ledger.readVerified();
      const latest = foldSeals(after, scope).latest;
      if (latest === null) throw new Error("GATE-2 passed but the ledger holds no seal");
      const measured = standingSeal(after, scope, item.dir, vault)?.author_measured === true;
      return measured
        ? { status: "sealed", seal_id: latest.seal_id, round: latest.round, author_measured: true, gate2: "pass" }
        : { status: "stored", seal_id: latest.seal_id, round: latest.round, author_measured: false, gate2: "pass" };
    }
  }
}

/**
 * S2 of `omf run` (M3h-D4). It verifies; it never seals. A standing seal whose author preceded the start answers ok with the
 * set digest as its progress digest. Otherwise the line stops at the cause: for a `ready` item whose GATE-1 is not passing
 * that is `j2_open`; in every other case a person has to run `omf seal` (`scenarios_need_review`, J3). A guard refusal is
 * `gate_blocked` (J7). No session, key or runtime is passed in, so there is nothing to start.
 */
export function standingSealStation(location: ProjectLocation): Station {
  return {
    id: "S2",
    async run(ctx) {
      const env = locationEnv(location);
      try {
        assertLineSafe(location, env);
      } catch (error) {
        if (guardRefusal(error) === null) throw error;
        return { kind: "blocked", reason_code: "gate_blocked" };
      }
      const scope: DecisionScope = { goal_id: ctx.goalId, work_id: ctx.workId };
      const events = new Ledger(location.dir, ctx.now).readVerified();
      const standing = standingSeal(events, scope, ctx.item.dir, openVault(location, env));
      if (standing !== null && authorPrecedesStart(events, scope).ok) {
        return { kind: "ok", progress_digest: standing.seal.set_sha256 };
      }
      if (ctx.entryState === "ready") {
        const gate1 = evaluateGate1(foldDecisions(events, scope), ctx.now(), {
          leak: loadLeakContext(location.dir, scope.goal_id, events),
          intentQuestionIds: intentQuestionIds(ctx.item.intent.candidate.open_questions.length),
        });
        if (gate1.status !== "pass") return { kind: "blocked", reason_code: "j2_open" };
      }
      return { kind: "blocked", reason_code: "scenarios_need_review" };
    },
  };
}
