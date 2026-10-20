import { findWorkItem } from "../adapters/state-markdown.js";
import { createDockerRuntime } from "../container/docker-cli.js";
import { sweepItemOrphans } from "../container/item-sweep.js";
import type { ContainerRuntime } from "../container/runtime.js";
import { type OmfConfig, readConfig } from "../core/config.js";
import type { ProjectLocation } from "../core/paths.js";

/**
 * The runtime of the configured Docker context, or null when `[judge] docker_context` is unset (the client's current
 * context is never used). A caller that still needs a runtime object passes `createDockerRuntime({ context: null })`,
 * which refuses every call, and lets the station report the missing context in its own refusal order.
 */
export function openRuntime(config: OmfConfig, env: NodeJS.ProcessEnv): ContainerRuntime | null {
  const context = config.judge.docker_context;
  return context === null ? null : createDockerRuntime({ context, env });
}

/**
 * The item-level container sweep of a command that is about to refuse, finish or has just changed the item: this item's author
 * orphans while `seal.lock` is free, its implementer orphans while no live run holds the claim (`sweepItemOrphans`).
 * Best effort and silent: an unknown item, an unset `docker_context`, an unreadable `item.md` or config, a corrupt ledger or
 * a daemon that cannot answer sweeps nothing, and never changes what the command reports. `runtime` is passed by a command
 * that has one open already.
 */
export async function sweepItemBestEffort(
  location: ProjectLocation,
  workId: string,
  env: NodeJS.ProcessEnv,
  runtime?: ContainerRuntime | null,
): Promise<void> {
  try {
    const item = findWorkItem(location.dir, workId);
    const open = runtime ?? openRuntime(readConfig(location.dir), env);
    if (item === null || open === null) return;
    await sweepItemOrphans({
      runtime: open,
      itemDir: item.dir,
      workId: item.front.work_id,
      projectDir: location.dir,
    });
  } catch {
    // nothing to report: the next seal or run sweeps again
  }
}
