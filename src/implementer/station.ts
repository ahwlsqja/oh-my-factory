import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type AuditSurface, scanCanaries, textSurface } from "../audit/canary-scan.js";
import { containerSpecFor, goldenFor } from "../container/golden.js";
import { pinnedImage } from "../container/image-ref.js";
import { createMeasured, type MeasuredContainer } from "../container/measure.js";
import type { ContainerRuntime, ImageInfo } from "../container/runtime.js";
import { isImageId } from "../container/spec.js";
import { canonicalize, sha256Hex } from "../core/canonical-json.js";
import { type OmfConfig, readConfig } from "../core/config.js";
import { Ledger } from "../core/ledger.js";
import type { ProjectLocation } from "../core/paths.js";
import { writePrivateFile } from "../core/private-fs.js";
import { clearImplementerRequest, writeImplementerRequest } from "../decision/needs-human.js";
import { findDecision, foldDecisions } from "../decision/state.js";
import { INTERFACE_DECISION_ID } from "../decision/types.js";
import { HostGitError } from "../git/hardened.js";
import { exportTree } from "../git/ops.js";
import { exportBase, publishBranch, UserRepoError, userHeadCommit } from "../git/user-repo.js";
import type { CandidateRef, CandidateSource } from "../judge/candidate.js";
import { judgeForbiddenPaths } from "../judge/forbidden.js";
import type { FeedbackSlot } from "../judge/round-state.js";
import { sweepOrphans, type TrackedRuntime, trackRuntime } from "../judge/state.js";
import { foldSeals } from "../scenario/events.js";
import { assertLineSafe, guardRefusal, locationEnv } from "../vault/line-guard.js";
import { listVaultCanaryIndex, openVault } from "../vault/vault.js";
import { TEST_GLOBS } from "../work/risk.js";
import type { Station, StationContext, StationResult } from "../work/sequencer.js";
import { foldWorkBudget } from "../work/w-budget.js";
import type { ReasonCode } from "../work/w-events.js";
import { claudeSettings, createClaudeSession } from "./claude-session.js";
import { buildContextFiles, contextTar, explicitTestPathsFor, omfDir } from "./context-files.js";
import { discardRoundStage, measureRefusal, refusedCandidateEvent, roundStageDir, stopFor } from "./refusals.js";
import { type Credential, containsCredential, readCredential } from "./credential.js";
import {
  baseFixedEvent,
  baseFixedOf,
  type CandidateFacts,
  candidateCheckedEvent,
  publishedHeads,
  publishIntendedEvent,
  type SessionFacts,
  sessionCompletedEvent,
} from "./events.js";
import { scanCandidateHistory } from "./history-scan.js";
import { importBundle } from "./import.js";
import { checkPlanFirst } from "./plan.js";
import { buildImplementerPrompt } from "./prompt.js";
import { readConflictRequest } from "./request.js";
import type { ImplementerSession, SessionOutcome } from "./session.js";
import { implementerLogSurface, promptSurface, workspaceSurface } from "./surfaces.js";
import { implementerVendorRefusal } from "./vendor.js";
import { captureWorkspace, finalizeAndBundle, killAllProcesses, prepareWorkspace } from "./workspace.js";

export interface ImplementerLineDeps {
  location: ProjectLocation;
  /** Wrapped inside `implementerStations` with `trackRuntime`, so a killed line still removes the container. */
  runtime: ContainerRuntime;
  /** The slot S6 fills; round 2 and later put what it released into the prompt. */
  feedback: FeedbackSlot;
  /** Default: the Claude Code adapter. Tests pass a session that runs a script. */
  session?: (credential: Credential) => ImplementerSession;
  /** The only place the key is read. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Default `<item>/runs/<run_id>/implementer-stage`. */
  stageRoot?: (itemDir: string, runId: string) => string;
}

export interface ImplementerStations {
  S3: Station;
  candidates: CandidateSource;
  /** Removes any container the station still holds. Idempotent; errors are dropped. */
  dispose(): Promise<void>;
}

const blocked = (reason_code: ReasonCode): StationResult => ({ kind: "blocked", reason_code });

const defaultStageRoot = (itemDir: string, runId: string): string => join(itemDir, "runs", runId, "implementer-stage");

let implementerSerial = 0;

/** The candidate of the current round, handed to S4 to S6 only for the `(round, run)` it was made in. */
class CandidateHolder {
  #held: { round: number; runId: string; ref: CandidateRef } | null = null;

  hold(round: number, runId: string, ref: CandidateRef): void {
    this.#held = { round, runId, ref };
  }

  clear(): void {
    this.#held = null;
  }

  current(ctx: Pick<StationContext, "round" | "runId">): CandidateRef | null {
    const held = this.#held;
    return held !== null && held.round === ctx.round && held.runId === ctx.runId ? held.ref : null;
  }
}

/** What the container work hands back to the host: the bundle, the capture and the redacted log. */
interface Harvest {
  bundle: Buffer;
  capture: { bytes: Buffer; complete: boolean };
  log: string;
  logTruncated: boolean;
  notes: string | null;
}

/** The largest length up to `max` that does not end inside a multi-byte UTF-8 character of `bytes`. */
function utf8Boundary(bytes: Buffer, max: number): number {
  let end = Math.min(max, bytes.length);
  // A continuation byte is 10xxxxxx; step back over them and the lead byte they belong to.
  if (end < bytes.length) {
    while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  }
  return end;
}

/**
 * What the host reads of the workspace before anything is published: the credential (found by value) and the vault canaries,
 * in one pass over the exported tree and the container capture. Credential first, then canary, then "could not look".
 */
export async function scanWorkspace(
  surface: AuditSurface,
  canaries: readonly string[],
  credential: Credential,
): Promise<"clean" | "credential" | "canary" | "incomplete"> {
  let credentialSeen = false;
  // A key can straddle two read chunks. Like `scanCanaries`, keep the last (key length - 1) bytes between chunks and test the
  // joined window. The key is printable ASCII (`readCredential` refuses anything else), so its length in bytes is its length.
  const overlap = credential.reveal().length - 1;
  const watched: AuditSurface = {
    kind: "worktree",
    async *read() {
      let tail = Buffer.alloc(0);
      for await (const chunk of surface.read()) {
        const window = Buffer.concat([tail, Buffer.from(chunk)]);
        if (containsCredential(window, credential)) credentialSeen = true;
        tail = window.subarray(Math.max(0, window.length - overlap));
        yield chunk;
      }
    },
    incomplete: () => surface.incomplete?.() === true,
  };
  const scan = await scanCanaries(canaries, [watched], ["worktree"]);
  if (credentialSeen) return "credential";
  if (scan.total > 0) return "canary";
  return scan.status !== "scanned" || watched.incomplete?.() === true ? "incomplete" : "clean";
}

/**
 * S3, the implementer (spec §5.4, §5.6, §7). One run of the line, one round:
 * the tracked files of the base commit go into a measured container together with the rendered `spec.md` and `intent.md`;
 * the one vendor key is handed to the session only after the recorded measurement of that container is golden; the commits
 * come back as a bundle that is treated as hostile data (quarantine, strict fsck, tree and context checks); every reachable
 * blob and commit message, the exported tree and the container capture are scanned for the key and the vault canaries; and
 * only then is the single head published as `refs/heads/omf/<work-id>`. Every stop is one closed reason code: nothing a
 * container or the daemon printed leaves this function. A later round starts again from the recorded base, with the
 * feedback S6 released in the prompt and nothing else carried over.
 */
async function runS3(
  deps: ImplementerLineDeps,
  runtime: TrackedRuntime,
  holder: CandidateHolder,
  ctx: StationContext,
): Promise<StationResult> {
  const { location } = deps;
  const itemScope = { goal_id: ctx.goalId, work_id: ctx.workId };
  const scope = { ...itemScope, run_id: ctx.runId };
  const ledger = new Ledger(location.dir, deps.now ?? ctx.now);
  const stageRoot = (deps.stageRoot ?? defaultStageRoot)(ctx.item.dir, ctx.runId);

  // A new round supersedes an earlier request record and the staging of the round before it (S4 to S6 are done with it).
  holder.clear();
  clearImplementerRequest(ctx.item.dir);
  rmSync(stageRoot, { recursive: true, force: true });

  // Configuration, key and daemon. A missing key is the environment (spec §5.6): no container exists, a rerun can succeed.
  let config: OmfConfig;
  try {
    config = readConfig(location.dir);
  } catch {
    return stopFor({ from: "environment" });
  }
  // Only Claude runs as the implementer in this version: another vendor stops here, before any key is read.
  const vendorRefusal = implementerVendorRefusal(config);
  if (vendorRefusal !== null) return stopFor({ from: "vendor" });
  const imp = config.implementer;
  if (imp.image === null || config.judge.docker_context === null || runtime.context === null) {
    return stopFor({ from: "environment" });
  }
  const credential = readCredential("claude", deps.env ?? process.env);
  if (credential === null) return stopFor({ from: "environment" });
  try {
    if (!(await runtime.info()).ok || !(await runtime.endpoint()).local) return stopFor({ from: "environment" });
    // Leftovers of earlier runs, quarantines that may hold a key included, go before anything is created, even when S4 never ran.
    await sweepOrphans({ runtime, itemDir: ctx.item.dir, currentRunId: ctx.runId });
  } catch {
    return stopFor({ from: "environment" });
  }

  // The base: the user's HEAD at the item's first S3, pinned in the ledger; later rounds and reruns reuse it.
  const events = ledger.readVerified();
  // Only a resolved record counts, as in the seal's input check: an open, deferred or n/a interface is not a contract.
  const interfaceRecord = findDecision(foldDecisions(events, itemScope), INTERFACE_DECISION_ID);
  const contract = interfaceRecord !== null && interfaceRecord.status === "resolved" ? interfaceRecord.interface : null;
  if (contract === null) return stopFor({ from: "context" });
  let base: Awaited<ReturnType<typeof exportBase>>;
  try {
    assertLineSafe(location);
    const recorded = baseFixedOf(events, itemScope);
    const baseSha = recorded?.base_sha ?? (await userHeadCommit(location.repo));
    base = await exportBase({ repo: location.repo, baseSha, maxBytes: imp.max_workspace_bytes });
    if (recorded !== null && recorded.base_tree_sha !== base.base_tree_sha) return stopFor({ from: "context" });
    // A base that already tracks this item's own directory is a rerun of an item that was merged.
    if (base.tracked_paths.some((path) => path.startsWith(`${omfDir(ctx.workId)}/`)))
      return stopFor({ from: "context" });
    if (recorded === null) {
      ledger.append(baseFixedEvent(scope, { base_sha: baseSha, base_tree_sha: base.base_tree_sha }));
    }
  } catch (error) {
    if (error instanceof UserRepoError) return stopFor({ from: "user_repo", code: error.code });
    if (error instanceof HostGitError || guardRefusal(error) !== null) return stopFor({ from: "guard" });
    throw error;
  }

  // Inputs, and the canary scan of every byte the container will be given, before the first exec.
  const built = buildContextFiles({ location, item: ctx.item, events });
  if (!built.ok) return stopFor({ from: "context" });
  const contextBytes = contextTar(ctx.workId, built.files);
  const prompt = buildImplementerPrompt({ workId: ctx.workId, round: ctx.round, feedback: deps.feedback.released() });
  const settings = claudeSettings({ denyEditGlobs: TEST_GLOBS });
  const listed = listVaultCanaryIndex(
    openVault(location, locationEnv(location)),
    ctx.workId,
    foldSeals(events, itemScope).records,
  );
  const canaries = [...new Set([...listed.index.map((entry) => entry.canary), ...listed.unverified_canaries])].sort();
  // No canary to look for, or a seal whose files do not verify, means the scan could not be complete: fail closed.
  if (canaries.length === 0 || listed.unverified.length > 0) return stopFor({ from: "context" });
  const pre = await scanCanaries(
    canaries,
    [
      textSurface("worktree", base.tar),
      textSurface("worktree", contextBytes),
      textSurface("prompt", prompt),
      textSurface("prompt", settings),
    ],
    ["worktree", "prompt"],
  );
  if (pre.total > 0 || pre.status !== "scanned") return stopFor({ from: "context" });

  const model = config.roles.implementer.model ?? null;
  const budget = foldWorkBudget(events, ctx.workId);
  const maxBudgetUsd =
    budget.effective === null
      ? null
      : Math.max(0, budget.effective.max_model_micro_usd - budget.spend.micro_usd) / 1_000_000;

  // The container: create, inspect, pre-gate, start, probe, record. Only a golden one comes back.
  let image: ImageInfo;
  let measured: MeasuredContainer;
  try {
    image = isImageId(imp.image)
      ? await runtime.imageInfo(imp.image)
      : await runtime.ensureImage(pinnedImage(imp.image));
    implementerSerial += 1;
    const spec = containerSpecFor({
      role: "implementer",
      image: image.id,
      labels: { work_id: ctx.workId, run_id: ctx.runId, round: ctx.round },
      serial: implementerSerial,
      limits: { kind: "implementer", implementer: imp },
    });
    measured = await createMeasured(
      { runtime, sink: ledger, scope, itemDir: ctx.item.dir, now: ctx.now },
      spec,
      goldenFor({ role: "implementer", image, forbidden: judgeForbiddenPaths(location) }),
    );
  } catch (error) {
    return stopFor(measureRefusal(error));
  }
  const container = measured.handle;
  const removeContainer = async (): Promise<void> => {
    try {
      await runtime.remove(container);
    } catch {
      // `dispose()` and the next sweep remove it by name and owner label.
    }
  };

  const runDir = join(ctx.item.dir, "runs", ctx.runId, "implementer", `round-${ctx.round}`);
  const session = deps.session?.(credential) ?? createClaudeSession({ runtime, credential, model });
  const recordSession = (outcome: SessionOutcome, stored: Buffer, workspace: SessionFacts["workspace"]): void => {
    ledger.append(
      sessionCompletedEvent(scope, {
        round: ctx.round,
        vendor: session.vendor,
        model: session.model,
        outcome: outcome.ok ? "completed" : outcome.code,
        duration_ms: Math.round(outcome.durationMs),
        image_id: image.id,
        prompt_sha256: sha256Hex(prompt),
        settings_sha256: sha256Hex(settings),
        log_sha256: sha256Hex(stored),
        log_bytes: stored.length,
        cost_micro_usd: outcome.ok ? outcome.cost_micro_usd : null,
        workspace,
        log_credential_hits: outcome.credential_hits,
        injected_secret_names: [credential.name],
      }),
    );
  };

  const inContainer = async (): Promise<Harvest | StationResult> => {
    const prepared = await prepareWorkspace(runtime, container, { baseTar: base.tar, contextTar: contextBytes });
    if (!prepared.ok) return stopFor({ from: "prepare", code: prepared.code });

    const outcome = await session.run(container, {
      prompt,
      settings,
      timeoutMs: imp.timeout_ms,
      maxOutputBytes: imp.max_log_bytes,
      model,
      maxBudgetUsd,
    });
    // The cost is recorded whatever the outcome; a failure to record it is not swallowed. A session that started and then
    // failed reported no cost but may have spent up to its --max-budget-usd, so that cap is recorded as an upper bound:
    // failing rounds then use up the item's limit instead of each being offered all of it again.
    const startedAndFailed =
      !outcome.ok && (outcome.code === "nonzero_exit" || outcome.code === "timeout" || outcome.code === "output_limit");
    ctx.recordSpend(
      outcome.ok
        ? outcome.cost_micro_usd
        : startedAndFailed && maxBudgetUsd !== null
          ? Math.round(maxBudgetUsd * 1_000_000)
          : null,
    );
    const raw = Buffer.from(outcome.log, "utf8");
    const logTruncated = raw.length > imp.max_log_bytes;
    // Cut at a character boundary, so the bytes that are hashed and the text that is written are the same.
    const stored = logTruncated ? raw.subarray(0, utf8Boundary(raw, imp.max_log_bytes)) : raw;
    writePrivateFile(join(runDir, "prompt.txt"), prompt);
    writePrivateFile(join(runDir, "settings.json"), settings);
    writePrivateFile(join(runDir, "implementer.log"), stored.toString("utf8"));
    if (!outcome.ok) {
      // Nothing of a failed session is kept or imported; the container goes at once.
      recordSession(outcome, stored, "not_captured");
      return stopFor({ from: "session", code: outcome.code });
    }

    // No background job of the implementer may survive into the capture or the finalize step.
    if (!(await killAllProcesses(runtime, container)).ok) {
      recordSession(outcome, stored, "not_captured");
      return stopFor({ from: "kill" });
    }
    const capture = await captureWorkspace(runtime, container, imp.max_workspace_bytes);
    recordSession(outcome, stored, capture.complete ? "captured" : "incomplete");
    const bundled = await finalizeAndBundle(runtime, container, imp.max_workspace_bytes);
    if (!bundled.ok) return stopFor({ from: "bundle", code: bundled.code });
    return { bundle: bundled.bundle, capture, log: stored.toString("utf8"), logTruncated, notes: outcome.notes };
  };
  const harvested = await inContainer().finally(removeContainer);
  if ("kind" in harvested) return harvested;

  // From here on only host code runs, over data the container wrote.
  const stage = roundStageDir(stageRoot, ctx.round);
  const dropStage = (): void => discardRoundStage(stageRoot, ctx.round);
  const checked = (facts: Partial<CandidateFacts>): void => {
    ledger.append(
      candidateCheckedEvent(scope, {
        round: ctx.round,
        head_sha: null,
        context_sha: null,
        commits: 0,
        plan: "not_checked",
        plan_why: null,
        request: "not_checked",
        scan: "not_run",
        import_failure: null,
        published: false,
        ...facts,
      }),
    );
  };
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  try {
    const imported = await importBundle({
      stageDir: stage,
      repo: location.repo,
      bundle: harvested.bundle,
      workId: ctx.workId,
      expect: { base_tree_sha: base.base_tree_sha, context: built.files },
    });
    if (!imported.ok) {
      dropStage();
      ledger.append(refusedCandidateEvent(scope, ctx.round, { import_failure: imported.code }));
      return stopFor({ from: "import", code: imported.code });
    }
    const { quarantine, head, context, work } = imported.value;
    const known = { head_sha: head, context_sha: context, commits: work.length };

    // Every reachable blob and commit message first (a key committed and later removed is found), then the exported tree and the capture.
    const history = await scanCandidateHistory({
      quarantine,
      head,
      credential,
      canaries: listed,
      maxTotalBytes: imp.max_workspace_bytes,
    });
    let scan: "clean" | "credential" | "canary" | "incomplete" = history.status;
    const treeDir = join(stage, `tree-${ctx.round}`);
    mkdirSync(treeDir, { mode: 0o700 });
    const workspace = workspaceSurface({ treeDir, capture: harvested.capture });
    if (scan === "clean") {
      await exportTree(quarantine, head, treeDir);
      scan = await scanWorkspace(workspace, canaries, credential);
    }
    if (scan !== "clean") {
      dropStage(); // no key and no canary stays on disk
      ledger.append(refusedCandidateEvent(scope, ctx.round, { ...known, scan }));
      return stopFor({ from: "scan", status: scan });
    }

    const request = await readConflictRequest(quarantine, ctx.workId, head, new Set(base.tracked_paths));
    if (request.status === "invalid") {
      dropStage();
      ledger.append(refusedCandidateEvent(scope, ctx.round, { ...known, scan, request: "invalid" }));
      return stopFor({ from: "request_invalid" });
    }
    if (request.status === "raised") {
      writeImplementerRequest(ctx.item.dir, itemScope, request.request, ctx.now());
      dropStage();
      checked({ ...known, scan, request: "raised" });
      return blocked("implementer_request");
    }

    // The plan is judged now but only stops the station after the branch exists: a flawed candidate stays reviewable.
    const plan = await checkPlanFirst(quarantine, ctx.workId, context, work);
    const planFacts = { plan: plan.status, plan_why: plan.status === "missing" ? plan.why : null } as const;
    ledger.append(publishIntendedEvent(scope, { round: ctx.round, head_sha: head }));
    const scratchDir = join(stage, "publish");
    mkdirSync(scratchDir, { mode: 0o700 });
    try {
      await publishBranch({
        repo: location.repo,
        quarantine,
        workId: ctx.workId,
        head,
        knownHeads: publishedHeads(ledger.readVerified(), itemScope),
        scratchDir,
      });
    } catch (error) {
      if (!(error instanceof UserRepoError)) throw error;
      dropStage();
      ledger.append(refusedCandidateEvent(scope, ctx.round, { ...known, scan, request: "none", ...planFacts }));
      return stopFor({ from: "user_repo", code: error.code });
    }
    checked({ ...known, scan, request: "none", ...planFacts, published: true });
    if (plan.status === "missing") {
      dropStage();
      return blocked("plan_missing");
    }

    ctx.inputs.plan_summary = plan.summary;
    if (harvested.notes !== null) ctx.inputs.implementer_notes = harvested.notes;
    holder.hold(ctx.round, ctx.runId, {
      quarantine,
      base: context,
      head,
      explicitTestPaths: explicitTestPathsFor(contract.test_command, base.tracked_paths),
      surfaces: [
        workspace,
        implementerLogSurface(harvested.log, { truncated: harvested.logTruncated }),
        promptSurface([prompt, settings]),
      ],
    });
    return { kind: "ok", progress_digest: sha256Hex(canonicalize({ head, commits: work.length })) };
  } catch (error) {
    dropStage();
    if (error instanceof HostGitError) return stopFor({ from: "guard" });
    throw error;
  }
}

/** The S3 station of one line and the candidate source the judge stations read from. */
export function implementerStations(deps: ImplementerLineDeps): ImplementerStations {
  const runtime = trackRuntime(deps.runtime);
  const holder = new CandidateHolder();
  return {
    S3: { id: "S3", run: (ctx) => runS3(deps, runtime, holder, ctx) },
    candidates: { current: async (ctx) => holder.current(ctx) },
    async dispose() {
      holder.clear();
      try {
        runtime.close();
      } catch {
        // What stays behind is removed by name at the next S3 start.
      }
    },
  };
}

/**
 * `runLine` takes one `onLineEnd`. This runs any number of them, awaited in order, and drops their errors: cleanup never
 * changes what the line returns, and what it leaves behind is swept by the next run.
 */
export function combineLineEnd(...fns: ReadonlyArray<() => Promise<void>>): () => Promise<void> {
  return async () => {
    for (const fn of fns) {
      try {
        await fn();
      } catch {
        // The next run's sweep finds what this one could not remove.
      }
    }
  };
}
