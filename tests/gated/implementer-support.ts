import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessResult } from "../../src/adapters/process-group.js";
import { containerSpecFor, goldenFor } from "../../src/container/golden.js";
import { pinnedImage } from "../../src/container/image-ref.js";
import { createMeasured } from "../../src/container/measure.js";
import type { ContainerHandle, ContainerRuntime, ImageInfo } from "../../src/container/runtime.js";
import { CONFIG_DEFAULTS } from "../../src/core/config.js";
import { Ledger } from "../../src/core/ledger.js";
import { exportBase, publishBranch, userHeadCommit } from "../../src/git/user-repo.js";
import { type ContextFiles, contextTar } from "../../src/implementer/context-files.js";
import type { Credential } from "../../src/implementer/credential.js";
import { type HistoryScan, scanCandidateHistory } from "../../src/implementer/history-scan.js";
import { importBundle } from "../../src/implementer/import.js";
import { type PlanCheck, checkPlanFirst } from "../../src/implementer/plan.js";
import type { ImplementerSession, SessionOutcome, SessionRequest } from "../../src/implementer/session.js";
import {
  captureWorkspace,
  finalizeAndBundle,
  killAllProcesses,
  prepareWorkspace,
} from "../../src/implementer/workspace.js";
import { trackRuntime } from "../../src/judge/state.js";
import { listFiles, put, realTempDir } from "../helpers/ops-fixture.js";
import { gitIn } from "../helpers/tmp.js";
import { type GatedContext, GatedRefusal } from "./helpers.js";
import { GATED_LABELS, GATED_SCOPE, gatedRuntime } from "./lifecycle-support.js";

// Shared by the three implementer suites. Nothing here runs unless a gated suite calls it, and nothing here reads or prints the
// vendor key: assertions that may see key-bearing values go through assertTrue and assertFalse, whose messages are fixed strings.

export const WORK_ID = GATED_LABELS.work_id;
const LIMIT = 64 * 1024 * 1024;

export function assertTrue(flag: boolean, message: string): void {
  if (!flag) throw new Error(message);
}
export function assertFalse(flag: boolean, message: string): void {
  if (flag) throw new Error(message);
}

export type CanaryIndex = Parameters<typeof scanCandidateHistory>[0]["canaries"];
export const NO_CANARIES: CanaryIndex = { index: [], unverified: [], unverified_canaries: [] };

export const CONTEXT: ContextFiles = {
  spec: "# Spec\n\nThe task is described in intent.md.\n",
  intent: "# Intent\n\nChange the greeting in src/greet.txt.\n",
};

/** The owner's implementer image: a digest reference or a local image id (`sha256:<64 hex>`). Never pulled by tag. */
export async function gatedImplementerImage(runtime: ContainerRuntime): Promise<ImageInfo> {
  const ref = process.env.OMF_GATED_IMPLEMENTER_IMAGE;
  if (ref === undefined || ref === "") {
    throw new GatedRefusal(
      "OMF_GATED_IMPLEMENTER_IMAGE must name the implementer image: a digest reference or a local image id",
    );
  }
  return /^sha256:[0-9a-f]{64}$/.test(ref) ? runtime.imageInfo(ref) : runtime.ensureImage(pinnedImage(ref));
}

export interface UserRepo {
  dir: string;
  head: string;
  untrackedMarker: string;
  ignoredMarker: string;
}

const COMMIT = [
  ...["user.name=omf-gated", "user.email=omf-gated@example.invalid", "commit.gpgsign=false"],
  ...["core.autocrlf=false", "core.safecrlf=false"],
].flatMap((setting) => ["-c", setting]);

/**
 * A real repository standing in for the user's: the tracked files, then (optionally) a `.gitattributes` committed second and
 * added alone, so a CRLF or `$Id$` blob committed before it stays as committed. One untracked and one ignored file carry random
 * markers that must never reach the container.
 */
export function makeUserRepo(files: Record<string, string>, attributes: string | null): UserRepo {
  const dir = realTempDir("omf-gated-user-");
  gitIn(dir, "init", "-q", "-b", "main");
  for (const [path, text] of Object.entries(files)) put(dir, path, text);
  put(dir, ".gitignore", "ignored.log\n");
  gitIn(dir, "add", "--all");
  gitIn(dir, ...COMMIT, "commit", "-q", "-m", "base");
  if (attributes !== null) {
    put(dir, ".gitattributes", attributes);
    gitIn(dir, "add", ".gitattributes");
    gitIn(dir, ...COMMIT, "commit", "-q", "-m", "attributes");
  }
  const untrackedMarker = `untracked-${randomBytes(8).toString("hex")}`;
  const ignoredMarker = `ignored-${randomBytes(8).toString("hex")}`;
  put(dir, "untracked.txt", `${untrackedMarker}\n`);
  put(dir, "ignored.log", `${ignoredMarker}\n`);
  return { dir, head: gitIn(dir, "rev-parse", "HEAD").trim(), untrackedMarker, ignoredMarker };
}

/** What a publish may not change in the user's repository, beyond the one new ref: HEAD, config, index, hooks and the files. */
export function snapshotRepo(dir: string) {
  const digest = (path: string): string =>
    createHash("sha256")
      .update(readFileSync(join(dir, path)))
      .digest("hex");
  return {
    refs: gitIn(dir, "for-each-ref", "--format=%(refname) %(objectname)").trim().split("\n"),
    head: readFileSync(join(dir, ".git", "HEAD"), "utf8"),
    config: readFileSync(join(dir, ".git", "config"), "utf8"),
    index: digest(".git/index"),
    hooks: listFiles(join(dir, ".git", "hooks")),
    files: listFiles(dir)
      .filter((path) => !path.startsWith(".git/"))
      .map((path) => `${path} ${digest(path)}`),
  };
}

/** The status and stdout of an exec that ran to the end; any other result is a fixed-message failure. */
export function exitedOf(result: ProcessResult): { status: number | null; stdout: string } {
  if (result.kind !== "exited") throw new Error(`the exec did not run to the end (${result.kind})`);
  return { status: result.status, stdout: result.stdout };
}

/** The implementer container, created and measured against the golden before it is returned; removal is the caller's. */
export async function measuredContainer(
  runtime: ContainerRuntime,
  input: { dir: string; repo: string; extraForbidden?: readonly string[] },
  image: ImageInfo,
) {
  const spec = containerSpecFor({
    role: "implementer",
    image: image.id,
    labels: GATED_LABELS,
    serial: 1,
    limits: { kind: "implementer", implementer: { ...CONFIG_DEFAULTS.implementer, image: image.id } },
  });
  const golden = goldenFor({
    role: "implementer",
    image,
    forbidden: [input.dir, input.repo, ...(input.extraForbidden ?? [])],
  });
  const sink = new Ledger(input.dir, () => new Date());
  const deps = { runtime, sink, scope: GATED_SCOPE, itemDir: join(input.dir, "item"), now: () => new Date() };
  return createMeasured(deps, spec, golden);
}

export interface RoundInput {
  ctx: GatedContext;
  repo: string;
  dir: string;
  files: ContextFiles;
  session: (runtime: ContainerRuntime) => ImplementerSession;
  request: SessionRequest;
  credential: Credential;
  canaries: CanaryIndex;
  extraForbidden?: readonly string[];
  /** Runs after the session and before the processes are stopped, with the container still up. */
  after?: (runtime: ContainerRuntime, handle: ContainerHandle) => Promise<void>;
}

export interface RoundResult {
  level: string;
  outcome: SessionOutcome;
  capture: { bytes: Buffer; complete: boolean };
  imported: Awaited<ReturnType<typeof importBundle>> | null;
  scan: HistoryScan | null;
  plan: PlanCheck | null;
  published: boolean;
}

/** The imported candidate, or a fixed-message failure. */
export function importedOf(round: RoundResult) {
  if (round.imported === null || !round.imported.ok) throw new Error("the bundle was not imported");
  return round.imported.value;
}

/**
 * The pieces of the implementer station, in the station's order, on a real container: export the base, create and measure the
 * container, prepare the workspace, run the session, stop every process, capture, bundle, import, scan the whole history, check
 * the plan, publish. It stops where the station stops: a failed session or bundle, an import failure, a scan hit (nothing is
 * published). The container and the runtime are always removed.
 */
export async function runImplementerRound(input: RoundInput): Promise<RoundResult> {
  const { ctx, repo, dir } = input;
  const runtime = trackRuntime(gatedRuntime(ctx));
  try {
    const image = await gatedImplementerImage(runtime);
    const base = await exportBase({ repo, baseSha: await userHeadCommit(repo), maxBytes: LIMIT });
    const { handle, measurement } = await measuredContainer(runtime, input, image);
    try {
      const tars = { baseTar: base.tar, contextTar: contextTar(WORK_ID, input.files) };
      assertTrue((await prepareWorkspace(runtime, handle, tars)).ok, "the workspace could not be prepared");
      const outcome = await input.session(runtime).run(handle, input.request);
      await input.after?.(runtime, handle);
      assertTrue((await killAllProcesses(runtime, handle)).ok, "the session's processes could not be stopped");
      const capture = await captureWorkspace(runtime, handle, LIMIT);
      const bundle = await finalizeAndBundle(runtime, handle, LIMIT);
      const result: RoundResult = {
        level: measurement.level,
        outcome,
        capture,
        imported: null,
        scan: null,
        plan: null,
        published: false,
      };
      if (!outcome.ok || !bundle.ok) return result;
      const stageDir = join(dir, "stage");
      mkdirSync(stageDir, { recursive: true, mode: 0o700 });
      const expected = { base_tree_sha: base.base_tree_sha, context: input.files };
      result.imported = await importBundle({
        stageDir,
        repo,
        bundle: bundle.bundle,
        workId: WORK_ID,
        expect: expected,
      });
      if (!result.imported.ok) return result;
      const { quarantine, head, context, work } = result.imported.value;
      const { credential, canaries } = input;
      result.scan = await scanCandidateHistory({ quarantine, head, credential, canaries, maxTotalBytes: LIMIT });
      result.plan = await checkPlanFirst(quarantine, WORK_ID, context, work);
      if (result.scan.status !== "clean") return result;
      const scratchDir = join(dir, "publish");
      mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
      await publishBranch({ repo, quarantine, workId: WORK_ID, head, knownHeads: [], scratchDir });
      result.published = true;
      return result;
    } finally {
      await runtime.remove(handle);
    }
  } finally {
    runtime.close();
  }
}

/**
 * What the real-run suite leaves for the driver to record next to the pass: the model name, the cost the adapter parsed and the
 * size of the redacted log (numbers only; the driver validates the shape). Does nothing outside a driver run.
 */
export function writeModelReport(report: { name: string; spend_micro_usd: number | null; log_bytes: number }): void {
  const file = process.env.OMF_GATED_MODEL_REPORT;
  if (file === undefined || file === "") return;
  writeFileSync(file, `${JSON.stringify({ vendor: "claude", ...report })}\n`);
}
