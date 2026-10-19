import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { JudgeConfig } from "../core/config.js";
import type { CommandResult, RunOptions, WorkCopy, WorkCopyFactory } from "../gate/ports.js";
import { createScratchGitDir, type GitTarget } from "../git/hardened.js";
import { applyPatchToDir, exportTree, isDirClean } from "../git/ops.js";
import type { StageGolden } from "../isolation/evaluate.js";
import { containerSpecFor, goldenFor } from "./golden.js";
import { createMeasured, type MeasureDeps, type MeasuredContainer, NotGoldenError } from "./measure.js";
import { containerState } from "./running.js";
import type { ContainerHandle, ContainerRuntime, ImageInfo } from "./runtime.js";
import { type ContainerSpec, type OwnedLabels, WORKCOPY_GATE_EXEC_S, WORKCOPY_GATE_EXECS } from "./spec.js";
import { tarOfDir } from "./tar-dir.js";

export type WorkCopyErrorCode = "build_failed" | "extract_failed" | "not_golden" | "timeout" | "container_gone";

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

function errorResult(error: unknown): CommandResult {
  return error instanceof WorkCopyError
    ? { kind: "error", code: `workcopy_${error.code}`, message: error.code }
    : { kind: "error", code: "runtime_error", message: "runtime_error" };
}

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
      await this.removeContainer();
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
    const result = await this.ctx.runtime.exec(this.container, {
      argv,
      ...(stdin === undefined ? {} : { stdin }),
      ...(workdir === undefined ? {} : { workdir }),
      timeoutMs,
      maxOutputBytes: OUTPUT_LIMIT_BYTES,
    });
    if (result.kind === "timeout") throw new WorkCopyError("timeout");
    if (result.kind !== "exited" || result.status !== 0) throw new WorkCopyError(failure);
  }

  private async removeContainer(): Promise<void> {
    const handle = this.container;
    this.container = null;
    if (handle !== null) await this.ctx.runtime.remove(handle);
  }

  /**
   * Every command runs at most `WORKCOPY_GATE_EXEC_S` seconds, whatever timeout the caller injects, because the lifetime is sized from it.
   * A container that has served `WORKCOPY_GATE_EXECS` commands is replaced like a stale one, so no container is asked for more than its
   * lifetime was sized for. A failure to recreate comes back as an error result, because `proveTest` does not catch a throw from `run` and `runGates` reads an
   * error result as `skip`. A timeout or the output limit kills only the docker client, not the process in the container, so the
   * container is removed by name and the next command starts in a fresh one: nothing keeps running behind it.
   */
  async run(argv: readonly string[], options: RunOptions): Promise<CommandResult> {
    if (this.gone) return { kind: "error", code: "runtime_error", message: "runtime_error" };
    try {
      if (this.stale || this.execs >= WORKCOPY_GATE_EXECS) {
        await this.removeContainer();
        await this.boot();
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
        await this.removeContainer();
      } else if (
        ((result.kind === "exited" && result.status !== 0) || result.kind === "error") &&
        (await containerState(this.ctx.runtime, this.container)) !== "running"
      ) {
        // The container is gone or its state is unknown (a failed inspect), after a non-zero exit of any status or an exec client
        // error. A command cannot end its own container (PID 1 is the idle sleep, which takes no signal), so this is the host's
        // doing, never a gate or test result: it comes back as an error result, like a failed recreate.
        this.stale = true;
        await this.removeContainer();
        return errorResult(new WorkCopyError("container_gone"));
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
