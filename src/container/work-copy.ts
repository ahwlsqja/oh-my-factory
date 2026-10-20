import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { JudgeConfig } from "../core/config.js";
import type { CommandResult, RunOptions, WorkCopy, WorkCopyFactory } from "../gate/ports.js";
import { createScratchGitDir, type GitTarget } from "../git/hardened.js";
import { applyPatchToDir, exportTree, isDirClean } from "../git/ops.js";
import type { StageGolden } from "../isolation/evaluate.js";
import { containerSpecFor, goldenFor } from "./golden.js";
import { createMeasured, type MeasureDeps, type MeasuredContainer, NotGoldenError } from "./measure.js";
import { markHostEnded } from "./lifecycle.js";
import { stopCause } from "./running.js";
import type { ContainerHandle, ContainerRuntime, ImageInfo } from "./runtime.js";
import { type ContainerSpec, type OwnedLabels, WORKCOPY_GATE_EXEC_S, WORKCOPY_GATE_EXECS } from "./spec.js";
import { tarOfDir } from "./tar-dir.js";

export type WorkCopyErrorCode =
  | "build_failed"
  | "extract_failed"
  | "not_golden"
  | "runtime_error"
  | "timeout"
  | "container_gone"
  | "exit_unknown";

/** The message is the code; no path and no command output ever appears in it. */
export class WorkCopyError extends Error {
  constructor(readonly code: WorkCopyErrorCode) {
    super(code);
    this.name = "WorkCopyError";
  }
}

/**
 * How a container is made and measured. The default is `createMeasured`, so a work-copy container is judged against the golden
 * on its `docker inspect` facts before it starts. The parameter exists so that a test can run the lifecycle without a daemon;
 * nothing under `src/` passes one.
 */
export type Launch = (spec: ContainerSpec, golden: StageGolden) => Promise<MeasuredContainer>;

export interface ContainerWorkCopyDeps {
  runtime: ContainerRuntime;
  measure: MeasureDeps;
  /** The pinned SUT BASE image, not the round's built image: the writable /work tmpfs hides anything the image holds there. */
  image: ImageInfo;
  /** The contract's declared build argv; run once in /work after extraction and again after every recreate. May be empty. */
  build: readonly string[];
  labels: Omit<OwnedLabels, "role">;
  config: JudgeConfig;
  /** Host staging root, `<item>/runs/<run_id>/judge`. */
  stageRoot: string;
  forbidden: readonly string[];
}

/** The caps of the two boot execs; `WORKCOPY_BOOT_S` in spec.ts is their sum in seconds. */
export const EXTRACT_TIMEOUT_MS = 120_000;
export const BUILD_TIMEOUT_MS = 600_000;
const OUTPUT_LIMIT_BYTES = 1024 * 1024;

let copySerial = 0;
let containerSerial = 0;

const RUNTIME_ERROR_RESULT: CommandResult = { kind: "error", code: "runtime_error", message: "runtime_error" };

function errorResult(error: unknown): CommandResult {
  return error instanceof WorkCopyError && error.code !== "runtime_error"
    ? { kind: "error", code: `workcopy_${error.code}`, message: error.code }
    : RUNTIME_ERROR_RESULT;
}

/**
 * What a recreate whose candidate build (or extract) failed is reported as: an error result with its own code, never a status.
 * The candidate's build is not reproducible, which is the candidate's failure, so `runGates` fails the gate; and because it
 * carries no exit status, `proveTest` cannot read it as a test status (a failing test is what PROVEN needs).
 */
const BOOT_FAILED_RESULT: CommandResult = { kind: "error", code: "workcopy_boot_failed", message: "boot_failed" };

/** What a command in a container that stopped early on its own is reported as: the candidate's failure, but never a status. */
const CANDIDATE_STOPPED_RESULT: CommandResult = {
  kind: "error",
  code: "workcopy_candidate_stopped",
  message: "candidate_stopped",
};

class ContainerWorkCopy implements WorkCopy {
  readonly id: string;
  private readonly root: string;
  private readonly tree: string;
  private readonly holder: string;
  private scratchGitDir = "";
  private container: ContainerHandle | null = null;
  private lastName: string | null = null;
  private stale = true;
  /** Gate execs served by the current container; its lifetime is sized for `WORKCOPY_GATE_EXECS` of them. */
  private execs = 0;
  private gone = false;
  /** The boot exec in progress (or last run): tells a build timeout, which is the candidate's, from an extract timeout. */
  private bootExec: "extract_failed" | "build_failed" = "extract_failed";

  constructor(
    private readonly ctx: ContainerWorkCopyDeps & { launch: Launch },
    private readonly quarantine: GitTarget,
    private readonly sha: string,
  ) {
    copySerial += 1;
    this.id = `wc-${process.pid}-${copySerial}`;
    this.root = join(ctx.stageRoot, this.id);
    this.tree = join(this.root, "tree");
    this.holder = join(this.root, "s");
  }

  /** Stage the tree on the host (git objects only, no hostile data), then boot the first container. */
  async open(): Promise<void> {
    mkdirSync(this.tree, { recursive: true, mode: 0o700 });
    mkdirSync(this.holder, { mode: 0o700 });
    try {
      await exportTree(this.quarantine, this.sha, this.tree);
      this.scratchGitDir = await createScratchGitDir(this.holder);
      await this.boot();
    } catch (error) {
      rmSync(this.root, { recursive: true, force: true });
      throw error;
    }
  }

  /** create, measure (the pre-gate refuses a non-golden container before it starts), extract, build. Removes the container on failure. */
  private async boot(): Promise<void> {
    const { ctx } = this;
    containerSerial += 1;
    const spec: ContainerSpec = containerSpecFor({
      role: "workcopy",
      image: ctx.image.id,
      labels: ctx.labels,
      serial: containerSerial,
      limits: { kind: "judge", judge: ctx.config },
    });
    this.lastName = spec.name;
    let measured: MeasuredContainer;
    try {
      measured = await ctx.launch(spec, goldenFor({ role: "workcopy", image: ctx.image, forbidden: ctx.forbidden }));
    } catch (error) {
      throw error instanceof NotGoldenError ? new WorkCopyError("not_golden") : error;
    }
    this.container = measured.handle;
    this.execs = 0;
    try {
      await this.step(["tar", "-x", "-C", "/work"], EXTRACT_TIMEOUT_MS, "extract_failed", tarOfDir(this.tree));
      if (ctx.build.length > 0) await this.step(ctx.build, BUILD_TIMEOUT_MS, "build_failed", undefined, "/work");
      this.stale = false;
    } catch (error) {
      // The failure that is thrown is the one that decided the result; a failed removal must not replace it.
      await this.removeQuietly();
      throw error;
    }
  }

  private async step(
    argv: readonly string[],
    timeoutMs: number,
    failure: "extract_failed" | "build_failed",
    stdin?: Buffer,
    workdir?: string,
  ): Promise<void> {
    if (this.container === null) throw new WorkCopyError(failure);
    this.bootExec = failure;
    const result = await this.ctx.runtime.exec(this.container, {
      argv,
      ...(stdin === undefined ? {} : { stdin }),
      ...(workdir === undefined ? {} : { workdir }),
      timeoutMs,
      maxOutputBytes: OUTPUT_LIMIT_BYTES,
    });
    if (result.kind === "timeout") throw new WorkCopyError("timeout");
    // The docker client failed or was killed: nothing says what the candidate's command did, so it is the host's, not the candidate's.
    if (result.kind !== "exited" || result.status === null) throw new WorkCopyError("runtime_error");
    if (result.status !== 0) {
      // A daemon that stopped answering makes the docker client exit non-zero too, so ask why the container is not running, as run() does.
      const { cause } = await stopCause(this.ctx.runtime, this.container);
      if (cause === "host" || cause === "unknown") throw new WorkCopyError("runtime_error");
      throw new WorkCopyError(failure);
    }
  }

  private async removeContainer(): Promise<void> {
    const handle = this.container;
    this.container = null;
    if (handle === null) return;
    markHostEnded(handle);
    await this.ctx.runtime.remove(handle);
  }

  /**
   * Removes the container where a result is already decided. A failed removal leaves an orphan that stops itself and that
   * `lastName` still lets `abortSync` and the sweep reach; it must never change the result, so the error is dropped here.
   */
  private async removeQuietly(): Promise<void> {
    try {
      await this.removeContainer();
    } catch {
      // the decided result stands
    }
  }

  /** Replaces the container. A failure of the candidate's own build or extract is a failing result; any other is infrastructure. */
  private async recreate(): Promise<CommandResult | null> {
    try {
      await this.removeContainer();
      await this.boot();
      return null;
    } catch (error) {
      if (error instanceof WorkCopyError) {
        const candidate =
          error.code === "build_failed" ||
          error.code === "extract_failed" ||
          (error.code === "timeout" && this.bootExec === "build_failed");
        if (candidate) return BOOT_FAILED_RESULT;
      }
      return RUNTIME_ERROR_RESULT;
    }
  }

  /**
   * Every command runs at most `WORKCOPY_GATE_EXEC_S` seconds, whatever timeout the caller injects, because the lifetime is sized from it.
   * A container that has served `WORKCOPY_GATE_EXECS` commands is replaced like a stale one, so no container is asked for more than its
   * lifetime was sized for. A failure to recreate comes back as a result, because `proveTest` does not catch a throw from `run`, and
   * never as a status. Two causes are told apart:
   * - the candidate's own build or extract failed (an exec that exited with a non-zero status, or a build timeout): the error result
   *   `workcopy_boot_failed`, which `runGates` turns into `fail` and `proveTest` into no test status (MISCONFIGURED);
   * - anything the candidate cannot cause (the docker client failed or exited with no status, an extract timeout, create, measure,
   *   a golden refusal, the daemon): the error result `runtime_error`, which `runGates` turns into an infrastructure stop
   *   (`GateInfrastructureError`) and `proveTest` into no test status.
   * `runGates` also stops the line on the results that mean a lost container (`container_gone`, `exit_unknown`). A result that is already
   * decided is never changed by a failed removal of the container. A null exit status is never inspected: it is `exit_unknown`
   * whatever the container state. After a non-zero exit or an exec client error, `stopCause` says why a container is not running: the
   * host's (removed, stopped, lifetime elapsed, or unknown) is `container_gone`, and a container that stopped early on its own is the
   * command's failure, the error result `workcopy_candidate_stopped` (no status is passed on, so `runGates` fails the gate and
   * `proveTest` reads no test status). A timeout or the output limit kills only the docker client, not the process in the container, so the
   * container is removed by name and the next command starts in a fresh one: nothing keeps running behind it.
   */
  async run(argv: readonly string[], options: RunOptions): Promise<CommandResult> {
    if (this.gone) return RUNTIME_ERROR_RESULT;
    try {
      if (this.stale || this.execs >= WORKCOPY_GATE_EXECS) {
        const failed = await this.recreate();
        if (failed !== null) return failed;
      }
      if (this.container === null) return errorResult(null);
      this.execs += 1;
      const result = await this.ctx.runtime.exec(this.container, {
        argv,
        workdir: "/work",
        timeoutMs: Math.min(options.timeoutMs, WORKCOPY_GATE_EXEC_S * 1000),
        maxOutputBytes: options.maxOutputBytes,
      });
      if (result.kind === "timeout" || result.kind === "output_limit") {
        this.stale = true;
        await this.removeQuietly();
      } else if (result.kind === "exited" && result.status === null) {
        // No status: the docker client was killed, so nothing says how the command ended or whether it still runs.
        this.stale = true;
        await this.removeQuietly();
        return errorResult(new WorkCopyError("exit_unknown"));
      } else if ((result.kind === "exited" && result.status !== 0) || result.kind === "error") {
        const { cause } = await stopCause(this.ctx.runtime, this.container);
        if (cause === "host" || cause === "unknown") {
          // The host removed or stopped the container, its lifetime ran out, or the daemon would not say: not the command's
          // doing, so it comes back as an error result (like a failed recreate), never as a gate or test result.
          this.stale = true;
          await this.removeQuietly();
          return errorResult(new WorkCopyError("container_gone"));
        }
        if (cause === "candidate") {
          // The container stopped early on its own (the command ended its PID 1 or pushed it into an OOM kill): the command's
          // failure, but whatever the exec client reported is a status of the stop, not of the command, so none is passed on.
          // `runGates` fails the gate, `proveTest` reads no test status, and the next command starts in a fresh container.
          this.stale = true;
          await this.removeQuietly();
          return CANDIDATE_STOPPED_RESULT;
        } else if (result.kind === "error") {
          // The container still runs, so only the docker client failed (it could not be started): the host's doing, and a
          // gate result must never be made of it. It reaches `runGates` as `runtime_error`, not as the client's own code.
          return errorResult(null);
        }
      }
      return result;
    } catch (error) {
      return errorResult(error);
    }
  }

  /** "Clean" speaks of the staged tree only; whatever a gate changed inside the container never flows back and vanishes on recreate. */
  isClean(): Promise<boolean> {
    return isDirClean({ gitDir: this.quarantine.gitDir, indexFile: join(this.holder, "index") }, this.sha, this.tree);
  }

  async applyPatch(patch: string, options: { reverse: boolean }): Promise<boolean> {
    const applied = await applyPatchToDir(this.scratchGitDir, this.tree, patch, options);
    if (applied) this.stale = true;
    return applied;
  }

  async dispose(): Promise<void> {
    this.gone = true;
    await this.removeContainer();
    rmSync(this.root, { recursive: true, force: true });
  }

  abortSync(): void {
    this.gone = true;
    const name = this.lastName;
    this.container = null;
    if (name !== null) this.ctx.runtime.removeAllSync([name]);
    rmSync(this.root, { recursive: true, force: true });
  }
}

/**
 * The container version of the host work copy. The copy stages the quarantine commit on the host with `exportTree`,
 * turns the staging directory into a tar Buffer and extracts it inside a `workcopy` container with `docker exec -i ... tar -x`.
 * No path is mounted, and this file starts no process: every command is a `ContainerRuntime.exec` request.
 */
export class ContainerWorkCopyFactory implements WorkCopyFactory {
  private readonly launch: Launch;

  constructor(
    private readonly deps: ContainerWorkCopyDeps,
    launch?: Launch,
  ) {
    this.launch = launch ?? ((spec, golden) => createMeasured(deps.measure, spec, golden));
  }

  async create(spec: { quarantine: GitTarget; sha: string }): Promise<WorkCopy> {
    const copy = new ContainerWorkCopy({ ...this.deps, launch: this.launch }, spec.quarantine, spec.sha);
    await copy.open();
    return copy;
  }
}
