import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pinnedImage } from "../container/image-ref.js";
import type { ContainerRuntime } from "../container/runtime.js";
import { ContainerWorkCopyFactory } from "../container/work-copy.js";
import { readConfig } from "../core/config.js";
import { Ledger } from "../core/ledger.js";
import type { ProjectLocation } from "../core/paths.js";
import type { InterfaceContract } from "../decision/types.js";
import type { StationContext } from "../work/sequencer.js";
import { judgeForbiddenPaths } from "./forbidden.js";

/** The closed reasons the copies could not be set up: no base image configured, or anything the environment refused. */
export class WorkCopiesError extends Error {
  constructor(readonly code: "image_not_configured" | "environment") {
    super(code);
    this.name = "WorkCopiesError";
  }
}

export interface WorkCopiesDeps {
  location: ProjectLocation;
  runtime: ContainerRuntime;
  stageRoot?: (itemDir: string, runId: string) => string;
}

/**
 * The one factory that gives gates and prove-test a place to run candidate code: a measured container per copy, built from the
 * pinned base image of `config.toml` (the writable `/work` of a copy would hide anything the round's own image held there). Every
 * failure to get that far, a missing image setting included, is a `WorkCopiesError` whose message is its code: the caller turns it
 * into a stop of the station and nothing from the environment (a daemon message, a path) travels with it.
 */
export async function containerWorkCopies(
  deps: WorkCopiesDeps,
  ctx: StationContext,
  contract: Pick<InterfaceContract, "build">,
): Promise<ContainerWorkCopyFactory> {
  try {
    const config = readConfig(deps.location.dir).judge;
    if (config.sut_base_image === null) throw new WorkCopiesError("image_not_configured");
    const image = await deps.runtime.ensureImage(pinnedImage(config.sut_base_image));
    const itemDir = ctx.item.dir;
    const stageRoot = deps.stageRoot?.(itemDir, ctx.runId) ?? join(itemDir, "runs", ctx.runId, "judge");
    mkdirSync(stageRoot, { recursive: true, mode: 0o700 });
    return new ContainerWorkCopyFactory({
      runtime: deps.runtime,
      measure: {
        runtime: deps.runtime,
        sink: new Ledger(deps.location.dir, ctx.now),
        scope: { goal_id: ctx.goalId, work_id: ctx.workId, run_id: ctx.runId },
        itemDir,
        now: ctx.now,
      },
      image,
      build: contract.build,
      labels: { work_id: ctx.workId, run_id: ctx.runId, round: ctx.round },
      config,
      stageRoot,
      forbidden: judgeForbiddenPaths(deps.location),
    });
  } catch (error) {
    throw error instanceof WorkCopiesError ? error : new WorkCopiesError("environment");
  }
}
